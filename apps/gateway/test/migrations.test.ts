import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deliveries, webhookEvents } from "../src/core/db/schema";
import { testDeps } from "./helpers/deps";
import { seedDelivery, seedPipeline } from "./helpers/seed";

function migration(prefix: string) {
	const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith(prefix));
	if (!m) throw new Error(`migration ${prefix} not found`);
	return m;
}

const UNIQUE_INDEX = "webhook_events_source_provider_uq";

describe("0003 + 0004", () => {
	it("collapses M1 duplicates so the unique index can be built", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const createIndex = migration("0004").queries.find((q) =>
			q.includes(UNIQUE_INDEX),
		);
		if (!createIndex) throw new Error("0004 has no unique index");
		// Recreate the M1 state: no unique index, duplicates present.
		await env.DB.prepare(`DROP INDEX ${UNIQUE_INDEX}`).run();
		try {
			const first = await seedDelivery(deps, p, {
				event: { providerEventId: "dup" },
			});
			const second = await seedDelivery(deps, p, {
				event: { providerEventId: "dup" },
			});
			const other = await seedDelivery(deps, p, {
				event: { providerEventId: "unique" },
			});

			await env.DB.batch(
				migration("0003").queries.map((q) => env.DB.prepare(q)),
			);
			await env.DB.prepare(createIndex).run();

			const ids = async (eventId: string) =>
				(
					await deps.db
						.select({ pid: webhookEvents.providerEventId })
						.from(webhookEvents)
						.where(eq(webhookEvents.id, eventId))
				)[0].pid;
			expect(await ids(first.eventId)).toBe("dup");
			expect(await ids(second.eventId)).toBeNull();
			expect(await ids(other.eventId)).toBe("unique");
			expect(
				await deps.db.$count(
					deliveries,
					eq(deliveries.projectId, p.project.id),
				),
			).toBe(3);
			// Drizzle wraps the D1 error: UNIQUE is in cause.message.
			const dupErr = await seedDelivery(deps, p, {
				event: { providerEventId: "dup" },
			}).then(
				() => null,
				(e) => e as Error,
			);
			expect(dupErr).not.toBeNull();
			expect(String(dupErr?.cause ?? dupErr)).toMatch(/UNIQUE/);
		} finally {
			await env.DB.prepare(
				createIndex.replace(
					"CREATE UNIQUE INDEX",
					"CREATE UNIQUE INDEX IF NOT EXISTS",
				),
			).run();
		}
	});

	it("allows many events without a provider event id", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p);
		await expect(seedDelivery(deps, p)).resolves.toBeDefined();
	});
});

describe("0005_admin_security", () => {
	it("creates the M3 tables and columns without rebuilding a table", async () => {
		const m = migration("0005");
		const sqlText = m.queries.join("\n");
		expect(sqlText).not.toMatch(/__new_|DROP TABLE|INSERT INTO/);
		const tables = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users','audit_logs','test_deliveries') ORDER BY name",
		).all<{ name: string }>();
		expect(tables.results.map((r) => r.name)).toEqual([
			"audit_logs",
			"test_deliveries",
			"users",
		]);
		const cols = async (table: string) =>
			(
				await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
					name: string;
				}>()
			).results.map((c) => c.name);
		expect(await cols("sources")).toEqual(
			expect.arrayContaining(["secret_prev_enc", "secret_prev_expires_at"]),
		);
		expect(await cols("destinations")).toEqual(
			expect.arrayContaining([
				"signing_secret_prev_enc",
				"signing_secret_prev_expires_at",
			]),
		);
		const idx = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'deliveries_status_completed_idx'",
		).first();
		expect(idx).not.toBeNull();
	});

	it("rejects an unknown role", async () => {
		await expect(
			env.DB.prepare(
				"INSERT INTO users (email, role, created_at, updated_at) VALUES ('x@example.com', 'root', 1, 1)",
			).run(),
		).rejects.toThrow(/CHECK/);
	});
});

describe("0006", () => {
	it("only creates stats_hourly and indexes (no table rebuild)", () => {
		const m = migration("0006");
		for (const q of m.queries) {
			expect(q.replace(/^--> statement-breakpoint\s*/, "").trim()).toMatch(
				/^CREATE (TABLE|INDEX)/,
			);
		}
		const all = m.queries.join("\n");
		expect(all).toContain("`stats_hourly`");
		expect(all).toContain("webhook_events_received_idx");
		expect(all).toContain("delivery_attempts_started_idx");
	});

	it("upserts on the composite primary key", async () => {
		const stmt = `INSERT INTO stats_hourly (hour, project_id, source_id, destination_id, received)
			VALUES (0, 'prj_m', 'src_m', 'dst_m', 1)
			ON CONFLICT (hour, project_id, source_id, destination_id) DO UPDATE SET received = received + excluded.received`;
		await env.DB.prepare(stmt).run();
		await env.DB.prepare(stmt).run();
		const row = await env.DB.prepare(
			"SELECT received, delivered FROM stats_hourly WHERE project_id = 'prj_m'",
		).first();
		expect(row).toEqual({ received: 2, delivered: 0 });
	});
});

describe("0007", () => {
	it("0007 only adds the two limit columns (no table rebuild)", () => {
		const sql = migration("0007_limiter").queries.join("\n");
		expect(sql).not.toMatch(/__new_/);
		expect(sql).toMatch(/ADD `max_in_flight` integer/);
		expect(sql).toMatch(/ADD `rate_limit_per_s` integer/);
	});
});

describe("0008_alerts", () => {
	it("0008 creates the alert tables without rebuilding destinations", () => {
		const sql = migration("0008_alerts").queries.join("\n");
		expect(sql).not.toMatch(/__new_/);
		expect(sql).toMatch(/CREATE TABLE `alert_channels`/);
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX `alerts_open_key_uq`.*WHERE status = 'open'/s,
		);
		expect(sql).toMatch(
			/ADD `consecutive_failures` integer DEFAULT 0 NOT NULL/,
		);
	});

	it("allows one open incident per key but many resolved ones", async () => {
		const db = env.DB;
		const ins = (id: string, status: string) =>
			db
				.prepare(
					"INSERT INTO alerts (id, rule, resource_type, resource_id, status, opened_at) VALUES (?, 'new_dead', 'destination', 'dst_mig', ?, 1)",
				)
				.bind(id, status)
				.run();
		await ins("alr_mig1", "resolved");
		await ins("alr_mig2", "resolved");
		await ins("alr_mig3", "open");
		await expect(ins("alr_mig4", "open")).rejects.toThrow(/UNIQUE/);
	});
});

describe("0009_archive", () => {
	it("0009 adds archive tables and marks without rebuilding webhook_events", () => {
		const sql = migration("0009_archive").queries.join("\n");
		expect(sql).not.toMatch(/__new_/);
		expect(sql).toMatch(/CREATE TABLE `archive_batches`/);
		expect(sql).toMatch(/ADD `archive_batch_id` text/);
		expect(sql).toMatch(/CREATE INDEX `webhook_events_archive_mark_idx`/);
	});
});
