import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { testDeps } from "./helpers/deps";
import { seedDelivery, seedPipeline } from "./helpers/seed";

async function columns(table: string) {
	return (
		await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
	).results.map((c) => c.name);
}

async function indexNames(table: string) {
	return (
		await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
		)
			.bind(table)
			.all<{ name: string }>()
	).results.map((r) => r.name);
}

describe("0000_init", () => {
	it("is the only migration (squashed at 1.0.0)", () => {
		expect(env.TEST_MIGRATIONS.map((m) => m.name)).toEqual([
			expect.stringMatching(/^0000_init/),
		]);
	});

	it("rejects a second event with the same provider event id", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, { event: { providerEventId: "dup" } });
		// Drizzle wraps the D1 error: UNIQUE is in cause.message.
		const dupErr = await seedDelivery(deps, p, {
			event: { providerEventId: "dup" },
		}).then(
			() => null,
			(e) => e as Error,
		);
		expect(dupErr).not.toBeNull();
		expect(String(dupErr?.cause ?? dupErr)).toMatch(/UNIQUE/);
	});

	it("allows many events without a provider event id", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p);
		await expect(seedDelivery(deps, p)).resolves.toBeDefined();
	});

	it("creates the admin tables and rotation columns", async () => {
		const tables = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users','audit_logs','test_deliveries') ORDER BY name",
		).all<{ name: string }>();
		expect(tables.results.map((r) => r.name)).toEqual([
			"audit_logs",
			"test_deliveries",
			"users",
		]);
		expect(await columns("sources")).toEqual(
			expect.arrayContaining(["secret_prev_enc", "secret_prev_expires_at"]),
		);
		expect(await columns("destinations")).toEqual(
			expect.arrayContaining([
				"signing_secret_prev_enc",
				"signing_secret_prev_expires_at",
				"max_in_flight",
				"rate_limit_per_s",
				"consecutive_failures",
			]),
		);
		expect(await indexNames("deliveries")).toContain(
			"deliveries_status_completed_idx",
		);
	});

	it("rejects an unknown role", async () => {
		await expect(
			env.DB.prepare(
				"INSERT INTO users (email, role, created_at, updated_at) VALUES ('x@example.com', 'root', 1, 1)",
			).run(),
		).rejects.toThrow(/CHECK/);
	});

	it("upserts stats_hourly on the composite primary key", async () => {
		const stmt = `INSERT INTO stats_hourly (hour, project_id, source_id, destination_id, received)
			VALUES (0, 'prj_m', 'src_m', 'dst_m', 1)
			ON CONFLICT (hour, project_id, source_id, destination_id) DO UPDATE SET received = received + excluded.received`;
		await env.DB.prepare(stmt).run();
		await env.DB.prepare(stmt).run();
		const row = await env.DB.prepare(
			"SELECT received, delivered FROM stats_hourly WHERE project_id = 'prj_m'",
		).first();
		expect(row).toEqual({ received: 2, delivered: 0 });
		expect(await indexNames("webhook_events")).toContain(
			"webhook_events_received_idx",
		);
		expect(await indexNames("delivery_attempts")).toContain(
			"delivery_attempts_started_idx",
		);
	});

	it("allows one open alert per key but many resolved ones", async () => {
		const ins = (id: string, status: string) =>
			env.DB.prepare(
				"INSERT INTO alerts (id, rule, resource_type, resource_id, status, opened_at) VALUES (?, 'new_dead', 'destination', 'dst_mig', ?, 1)",
			)
				.bind(id, status)
				.run();
		await ins("alr_mig1", "resolved");
		await ins("alr_mig2", "resolved");
		await ins("alr_mig3", "open");
		await expect(ins("alr_mig4", "open")).rejects.toThrow(/UNIQUE/);
	});

	it("creates the archive tables and the archive mark", async () => {
		expect(await columns("archive_batches")).not.toEqual([]);
		expect(await columns("webhook_events")).toContain("archive_batch_id");
		expect(await indexNames("webhook_events")).toContain(
			"webhook_events_archive_mark_idx",
		);
	});

	it("creates backups with status and started_at indexes", async () => {
		expect(await indexNames("backups")).toEqual(
			expect.arrayContaining(["backups_status_idx", "backups_started_at_idx"]),
		);
	});
});
