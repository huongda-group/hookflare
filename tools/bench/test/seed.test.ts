import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { idTimestamp, isId } from "../../../apps/gateway/src/core/ids";
import {
	mulberry32,
	type SeedRow,
	STATEMENT_LIMIT,
	seedRows,
	toSqlFiles,
	writeSqlFiles,
} from "../src/seed";

/** Deterministic RNG for tests (mulberry32). */
function seeded(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const AT = 1_760_000_000_000;

function collect(n: number, rng: () => number) {
	const rows = [...seedRows(n, rng, AT)];
	const byTable = new Map<string, Record<string, unknown>[]>();
	for (const r of rows) {
		const list = byTable.get(r.table) ?? [];
		list.push(r.row);
		byTable.set(r.table, list);
	}
	return byTable;
}

describe("seedRows status mix", () => {
	it("lands within ±2% of the 96/3/1 target with n = 1000", () => {
		const byTable = collect(1000, seeded(42));
		const deliveries = byTable.get("deliveries") ?? [];
		expect(deliveries.length).toBe(1000);
		const share = (status: string) =>
			deliveries.filter((d) => d.status === status).length / 1000;
		expect(share("delivered")).toBeGreaterThanOrEqual(0.94);
		expect(share("delivered")).toBeLessThanOrEqual(0.98);
		expect(share("failed_final")).toBeGreaterThanOrEqual(0.01);
		expect(share("failed_final")).toBeLessThanOrEqual(0.05);
		expect(share("dead")).toBeGreaterThanOrEqual(0);
		expect(share("dead")).toBeLessThanOrEqual(0.03);
	});
});

describe("seedRows shape", () => {
	it("yields one event and one delivery per event plus 1–3 attempts", () => {
		const byTable = collect(200, seeded(7));
		expect((byTable.get("webhook_events") ?? []).length).toBe(200);
		expect((byTable.get("deliveries") ?? []).length).toBe(200);
		const attempts = byTable.get("delivery_attempts") ?? [];
		const perDelivery = new Map<string, number>();
		for (const a of attempts) {
			perDelivery.set(
				a.delivery_id as string,
				(perDelivery.get(a.delivery_id as string) ?? 0) + 1,
			);
		}
		expect(perDelivery.size).toBe(200);
		for (const n of perDelivery.values()) {
			expect(n).toBeGreaterThanOrEqual(1);
			expect(n).toBeLessThanOrEqual(3);
		}
	});

	it("uses the gateway evt/dlv/att id prefixes", () => {
		const byTable = collect(50, seeded(9));
		for (const e of byTable.get("webhook_events") ?? []) {
			expect(e.id as string).toMatch(/^evt_/);
		}
		for (const d of byTable.get("deliveries") ?? []) {
			expect(d.id as string).toMatch(/^dlv_/);
		}
		for (const a of byTable.get("delivery_attempts") ?? []) {
			expect(a.id as string).toMatch(/^att_/);
		}
	});

	it("every attempt references a delivery that exists", () => {
		const byTable = collect(500, seeded(11));
		const deliveryIds = new Set(
			(byTable.get("deliveries") ?? []).map((d) => d.id as string),
		);
		const attempts = byTable.get("delivery_attempts") ?? [];
		expect(attempts.length).toBeGreaterThan(0);
		for (const a of attempts) {
			expect(deliveryIds.has(a.delivery_id as string)).toBe(true);
		}
	});

	it("spreads created_at over the trailing 30 days", () => {
		const byTable = collect(500, seeded(13));
		const days = 30 * 86_400_000;
		for (const d of byTable.get("deliveries") ?? []) {
			const created = d.created_at as number;
			expect(created).toBeLessThanOrEqual(AT);
			expect(created).toBeGreaterThanOrEqual(AT - days);
		}
	});
});

describe("toSqlFiles", () => {
	it("keeps every statement under 90,000 bytes and writes BLOBs as X'…'", async () => {
		const rows = [...seedRows(1000, seeded(42), AT)];
		const files = toSqlFiles(rows);
		expect(files.length).toBeGreaterThanOrEqual(1);
		let sawBlob = false;
		for (const file of files) {
			const text = await readFile(file, "utf8");
			expect(text).toContain("X'");
			sawBlob = true;
			for (const statement of text.split(";\n")) {
				if (statement.trim() === "") continue;
				expect(new TextEncoder().encode(`${statement};`).length).toBeLessThan(
					90000,
				);
			}
		}
		expect(sawBlob).toBe(true);
	});
});

function testDir(name: string): string {
	const dir = new URL(`../results/test-${name}/`, import.meta.url).pathname;
	mkdirSync(dir, { recursive: true });
	return dir;
}

function statementsOf(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => line);
}

describe("writeSqlFiles streaming", () => {
	it("writes parents first, splits files at maxBytes, and keeps every row", async () => {
		const dir = testDir("stream");
		const result = writeSqlFiles(seedRows(300, seeded(5), AT), {
			maxBytes: 400_000,
			dir,
		});
		expect(result.files.length).toBeGreaterThan(3);
		expect(result.rows.webhook_events).toBe(300);
		expect(result.rows.deliveries).toBe(300);
		expect(result.rows.delivery_attempts).toBeGreaterThanOrEqual(300);

		const tableOf = (statement: string) =>
			/^INSERT INTO (\w+) /.exec(statement)?.[1] ?? "";
		const order: string[] = [];
		const counts: Record<string, number> = {};
		for (const file of result.files) {
			const text = await readFile(file, "utf8");
			expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
				400_000,
			);
			for (const statement of statementsOf(text)) {
				const table = tableOf(statement);
				if (order.at(-1) !== table) order.push(table);
				counts[table] =
					(counts[table] ?? 0) + (statement.match(/\), \(/g)?.length ?? 0) + 1;
				expect(new TextEncoder().encode(statement).length).toBeLessThan(
					STATEMENT_LIMIT,
				);
			}
		}
		expect(order).toEqual([
			"webhook_events",
			"deliveries",
			"delivery_attempts",
		]);
		expect(counts.webhook_events).toBe(300);
		expect(counts.deliveries).toBe(300);
		expect(counts.delivery_attempts).toBe(result.rows.delivery_attempts);
		expect(result.files.map((f) => f.slice(f.lastIndexOf("/") + 1))).toEqual(
			result.files.map(
				(_, i) => `seed-${(i + 1).toString().padStart(3, "0")}.sql`,
			),
		);
	});

	it("removes stale seed-NNN.sql files before writing", () => {
		const dir = testDir("stale");
		writeFileSync(`${dir}seed-999.sql`, "stale", "utf8");
		writeFileSync(`${dir}keep.txt`, "keep", "utf8");
		writeSqlFiles(seedRows(5, seeded(1), AT), { dir });
		const names = readdirSync(dir);
		expect(names).not.toContain("seed-999.sql");
		expect(names).toContain("keep.txt");
		expect(names.filter((n) => n.endsWith(".part"))).toEqual([]);
	});

	it("measures statement size in UTF-8 bytes, not characters", async () => {
		const dir = testDir("utf8");
		// 4,000 chars but 8,000 bytes each: char counting would pack ~22 rows
		// into one statement and overflow the byte limit.
		const wide = "é".repeat(4000);
		function* rows(): Generator<SeedRow> {
			for (let i = 0; i < 60; i++) {
				yield { table: "notes", row: { id: i, body: wide } };
			}
		}
		const result = writeSqlFiles(rows(), { dir });
		for (const file of result.files) {
			for (const statement of statementsOf(await readFile(file, "utf8"))) {
				expect(new TextEncoder().encode(statement).length).toBeLessThan(
					STATEMENT_LIMIT,
				);
			}
		}
		expect(result.rows.notes).toBe(60);
	});

	it("throws when one row cannot fit a statement", () => {
		const dir = testDir("toolarge");
		function* rows(): Generator<SeedRow> {
			yield {
				table: "notes",
				row: { id: 1, body: "x".repeat(STATEMENT_LIMIT) },
			};
		}
		expect(() => writeSqlFiles(rows(), { dir })).toThrow(/statement limit/);
	});
});

describe("seed ids", () => {
	it("embed each row's own timestamp and stay unique", () => {
		const rows = [...seedRows(2000, seeded(21), AT)];
		const seen = new Set<string>();
		for (const { table, row } of rows) {
			const id = row.id as string;
			expect(isId(id)).toBe(true);
			expect(seen.has(id)).toBe(false);
			seen.add(id);
			if (table === "webhook_events") {
				expect(idTimestamp(id)).toBe(row.received_at);
			} else if (table === "deliveries") {
				expect(idTimestamp(id)).toBe(row.created_at);
			} else {
				expect(idTimestamp(id)).toBe(row.started_at);
			}
		}
	});

	it("are reproducible for the same seed and differ across seeds", () => {
		const ids = (seed: number) =>
			[...seedRows(20, mulberry32(seed), AT)].map((r) => r.row.id);
		expect(ids(77)).toEqual(ids(77));
		expect(ids(77)).not.toEqual(ids(78));
	});
});

describe("big payload mix", () => {
	it("puts ~10% of payloads in a 33–42 KB range that still fits a statement", () => {
		const events = [...seedRows(1000, seeded(3), AT, { big: true })].filter(
			(r) => r.table === "webhook_events",
		);
		const big = events
			.map((e) => e.row.size_bytes as number)
			.filter((s) => s > 32768);
		expect(big.length / 1000).toBeGreaterThanOrEqual(0.07);
		expect(big.length / 1000).toBeLessThanOrEqual(0.13);
		for (const size of big) {
			expect(size).toBeGreaterThanOrEqual(33 * 1024);
			expect(size).toBeLessThanOrEqual(42 * 1024);
		}
		expect(new Set(big).size).toBeGreaterThan(10);
		for (const e of events) {
			expect((e.row.body_inline as string).length).toBe(
				(e.row.size_bytes as number) * 2,
			);
		}
		const dir = testDir("big");
		expect(() =>
			writeSqlFiles(seedRows(300, seeded(3), AT, { big: true }), { dir }),
		).not.toThrow();
	});
});
