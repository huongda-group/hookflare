import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { testDeps } from "./helpers/deps";
import { seedDelivery, seedPipeline } from "./helpers/seed";

async function columns(table: string) {
	return (
		await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
	).results.map((c) => c.name);
}

/**
 * The pre-migration (0000_init) legacy actor column name: `actor_email`. This
 * test seeds a 1.0.0-era schema and then migrates it, so it must name the old
 * column to insert rows into it before the rename to `actor`.
 */
const LEGACY_ACTOR_COLUMN = "actor_email";

async function indexNames(table: string) {
	return (
		await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
		)
			.bind(table)
			.all<{ name: string }>()
	).results.map((r) => r.name);
}

/**
 * Drop every table in dependency order (D1 refuses `PRAGMA foreign_keys`), then
 * re-apply only `0000_init`, so the upgrade is exercised from the pre-M7 shape.
 * A failed `DROP TABLE` means a referencing table still exists; retry it next
 * pass, once its children are gone.
 */
async function resetToInit() {
	const { results } = await env.DB.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table'",
	).all<{ name: string }>();
	// `_cf_METADATA` is miniflare's own table and cannot be dropped.
	let remaining = results
		.map((r) => r.name)
		.filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
	while (remaining.length > 0) {
		const next: string[] = [];
		for (const name of remaining) {
			try {
				await env.DB.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
			} catch {
				next.push(name);
			}
		}
		if (next.length === remaining.length) {
			throw new Error(`could not drop tables: ${next.join(", ")}`);
		}
		remaining = next;
	}
	const init = env.TEST_MIGRATIONS[0];
	if (!init) throw new Error("0000_init migration missing");
	await applyD1Migrations(env.DB, [init]);
}

describe("0000_init", () => {
	it("applies 0000_init, then the built-in-auth migrations", () => {
		expect(env.TEST_MIGRATIONS.map((m) => m.name)).toEqual([
			expect.stringMatching(/^0000_init/),
			expect.stringMatching(/^0001_/),
			expect.stringMatching(/^0002_/),
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
				"INSERT INTO users (username, role, created_at, updated_at) VALUES ('x@example.com', 'root', 1, 1)",
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

describe("built-in auth migrations", () => {
	it("renames the identity and actor columns and adds user credentials", async () => {
		const userCols = await columns("users");
		expect(userCols).toEqual(
			expect.arrayContaining([
				"username",
				"password_hash",
				"password_changed_at",
			]),
		);
		expect(userCols).not.toContain("email");
		expect(await columns("audit_logs")).toContain("actor");
		expect(await columns("audit_logs")).not.toContain(LEGACY_ACTOR_COLUMN);
		expect(await columns("test_deliveries")).toContain("actor");
		expect(await columns("test_deliveries")).not.toContain(LEGACY_ACTOR_COLUMN);
	});

	it("creates sessions with its indexes", async () => {
		expect(await columns("sessions")).toEqual([
			"id_hash",
			"username",
			"created_at",
			"last_seen_at",
			"expires_at",
		]);
		expect(await indexNames("sessions")).toEqual(
			expect.arrayContaining(["sessions_username_idx", "sessions_expires_idx"]),
		);
	});

	it("creates api_tokens with the username index", async () => {
		expect(await columns("api_tokens")).toEqual([
			"id",
			"token_hash",
			"username",
			"name",
			"created_at",
			"expires_at",
			"last_used_at",
			"revoked_at",
		]);
		expect(await indexNames("api_tokens")).toContain("api_tokens_username_idx");
	});

	it("cascades sessions when the user is deleted", async () => {
		await env.DB.prepare(
			"INSERT INTO users (username, role, created_at, updated_at, password_hash) VALUES ('casc@x.io', 'admin', 1, 1, 'hash')",
		).run();
		await env.DB.prepare(
			"INSERT INTO sessions (id_hash, username, created_at, last_seen_at, expires_at) VALUES ('sess_casc', 'casc@x.io', 1, 1, 9999999999999)",
		).run();
		await env.DB.prepare(
			"DELETE FROM users WHERE username = 'casc@x.io'",
		).run();
		const row = await env.DB.prepare(
			"SELECT count(*) AS n FROM sessions WHERE username = 'casc@x.io'",
		).first<{ n: number }>();
		expect(row?.n).toBe(0);
	});

	it("rejects two api tokens with the same hash", async () => {
		await env.DB.prepare(
			"INSERT INTO users (username, role, created_at, updated_at, password_hash) VALUES ('tok@x.io', 'admin', 1, 1, 'hash')",
		).run();
		const ins = (id: string) =>
			env.DB.prepare(
				"INSERT INTO api_tokens (id, token_hash, username, name, created_at) VALUES (?, 'same-hash', 'tok@x.io', 'k', 1)",
			)
				.bind(id)
				.run();
		await ins("tok_1");
		await expect(ins("tok_2")).rejects.toThrow(/UNIQUE/);
	});

	it("upgrades a 0000_init database without losing identity or actor rows", async () => {
		await resetToInit();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO users (email, role, created_at, updated_at, disabled_at) VALUES ('a@x.io', 'admin', 1, 1, NULL)",
			),
			env.DB.prepare(
				"INSERT INTO users (email, role, created_at, updated_at, disabled_at) VALUES ('svc:bot', 'operator', 1, 1, NULL)",
			),
			env.DB.prepare(
				`INSERT INTO audit_logs (id, ${LEGACY_ACTOR_COLUMN}, action, resource_type, resource_id, at) VALUES ('aud_ll', 'a@x.io', 'user.created', 'user', 'a@x.io', 1)`,
			),
			env.DB.prepare(
				"INSERT INTO projects (id, name, slug, status, created_at, updated_at) VALUES ('prj_ll', 'P', 'prj-ll', 'active', 1, 1)",
			),
			env.DB.prepare(
				"INSERT INTO destinations (id, project_id, name, url, status, signing_secret_enc, created_at, updated_at) VALUES ('dst_ll', 'prj_ll', 'D', 'https://example.com', 'active', 'x', 1, 1)",
			),
			env.DB.prepare(
				`INSERT INTO test_deliveries (id, destination_id, project_id, ${LEGACY_ACTOR_COLUMN}, started_at, duration_ms) VALUES ('tst_ll', 'dst_ll', 'prj_ll', 'a@x.io', 1, 5)`,
			),
		]);

		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

		const users = await env.DB.prepare(
			"SELECT username, disabled_at FROM users ORDER BY username",
		).all<{ username: string; disabled_at: number | null }>();
		expect(users.results).toEqual([
			{ username: "a@x.io", disabled_at: null },
			{ username: "svc:bot", disabled_at: expect.any(Number) },
		]);
		const audit = await env.DB.prepare(
			"SELECT actor FROM audit_logs WHERE id = 'aud_ll'",
		).first<{ actor: string }>();
		expect(audit?.actor).toBe("a@x.io");
		const testDelivery = await env.DB.prepare(
			"SELECT actor FROM test_deliveries WHERE id = 'tst_ll'",
		).first<{ actor: string }>();
		expect(testDelivery?.actor).toBe("a@x.io");
	});
});
