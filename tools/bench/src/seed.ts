/**
 * B5 dataset seeder (local part): `node src/seed.ts --events <n>
 * --project <id> --source <id> --destination <id> --out <file>`.
 *
 * Generates a SQL file of synthetic `webhook_events`, `deliveries`, and
 * `delivery_attempts` rows with a realistic mix (1–3 attempts per delivery,
 * a few percent `failed_final`/`dead`), loadable with
 * `wrangler d1 execute --file --remote` against staging. Driving 1M events
 * through ingress would take hours; SQL seeding does not. Loading the file
 * is a manual, remote-changing step done with user approval.
 */

import { writeFile } from "node:fs/promises";

export type SeedOptions = {
	events: number;
	projectId: string;
	sourceId: string;
	destinationId: string;
	from: number;
};

function lcg(state: { n: number }): number {
	state.n = (Math.imul(state.n, 1103515245) + 12345) & 0x7fffffff;
	return state.n / 0x7fffffff;
}

function quote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function hex(bytes: number, rand: () => number): string {
	let out = "";
	for (let i = 0; i < bytes; i++) {
		out += Math.floor(rand() * 256)
			.toString(16)
			.padStart(2, "0");
	}
	return out;
}

/** One INSERT per event plus its initial delivery and attempts. */
export function seedStatements(options: SeedOptions): string[] {
	const randState = { n: options.events };
	const rand = () => lcg(randState);
	const out: string[] = [];
	for (let i = 0; i < options.events; i++) {
		const eventId = `seed-ev-${i.toString().padStart(7, "0")}`;
		const receivedAt = options.from + i * 86;
		const headers = quote(
			JSON.stringify({ "content-type": "application/json" }),
		);
		out.push(
			`INSERT INTO webhook_events (id, project_id, source_id, provider_event_id, received_at, headers_json, content_type, size_bytes, payload_sha256, body_inline, r2_key, archive_batch_id, archive_part) VALUES (${quote(eventId)}, ${quote(options.projectId)}, ${quote(options.sourceId)}, ${quote(`seed-${i}`)}, ${receivedAt}, ${headers}, ${quote("application/json")}, 512, ${quote(hex(32, rand))}, X'${hex(64, rand)}', NULL, NULL, NULL);`,
		);
		const roll = rand();
		const status =
			roll < 0.96 ? "delivered" : roll < 0.99 ? "failed_final" : "dead";
		const deliveryId = `seed-dl-${i.toString().padStart(7, "0")}`;
		const attempts = status === "delivered" ? 1 + Math.floor(rand() * 2) : 3;
		out.push(
			`INSERT INTO deliveries (id, event_id, destination_id, project_id, kind, status, attempt_count, enqueued_at, next_attempt_at, lease_until, last_http_status, last_error, completed_at, created_by, created_at) VALUES (${quote(deliveryId)}, ${quote(eventId)}, ${quote(options.destinationId)}, ${quote(options.projectId)}, 'initial', ${quote(status)}, ${attempts}, ${receivedAt}, NULL, NULL, 200, NULL, ${receivedAt + 1200}, 'seed', ${receivedAt});`,
		);
		for (let a = 1; a <= attempts; a++) {
			out.push(
				`INSERT INTO delivery_attempts (id, delivery_id, attempt_no, started_at, duration_ms, http_status, error_kind, error_message, response_snippet) VALUES (${quote(`seed-at-${i}-${a}`)}, ${quote(deliveryId)}, ${a}, ${receivedAt + a * 400}, 180, 200, NULL, NULL, NULL);`,
			);
		}
	}
	return out;
}

function flag(argv: string[], name: string): string | null {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

export async function main(argv: string[]): Promise<void> {
	const events = Number(flag(argv, "events") ?? "1000");
	const projectId = flag(argv, "project") ?? "";
	const sourceId = flag(argv, "source") ?? "";
	const destinationId = flag(argv, "destination") ?? "";
	const outFile = flag(argv, "out") ?? "";
	if (
		!Number.isInteger(events) ||
		events < 1 ||
		!projectId ||
		!sourceId ||
		!destinationId ||
		!outFile
	) {
		console.error(
			"usage: node src/seed.ts --events <n> --project <id> --source <id> --destination <id> --out <file>",
		);
		return process.exit(2);
	}
	await writeFile(
		outFile,
		`${seedStatements({
			events,
			projectId,
			sourceId,
			destinationId,
			from: Date.now(),
		}).join("\n")}\n`,
		"utf8",
	);
	console.error(`seed: wrote ${events} events to ${outFile}`);
}

const invoked = (process.argv[1] ?? "")
	.replace(/\\/g, "/")
	.endsWith("/seed.ts");
if (invoked) {
	await main(process.argv.slice(2));
}
