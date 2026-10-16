import { env } from "cloudflare:workers";
import * as shared from "@hookflare/shared";
import { describe, expect, it } from "vitest";
import * as db from "../../../src/core/db/schema";

const TABLES = [
	"settings",
	"projects",
	"destinations",
	"sources",
	"webhook_events",
	"deliveries",
	"delivery_attempts",
];

async function exec(sql: string, ...params: unknown[]) {
	return env.DB.prepare(sql)
		.bind(...params)
		.run();
}

async function insertProject(id: string, status = "active") {
	await exec(
		"INSERT INTO projects (id, name, slug, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
		id,
		"P",
		`slug-${id.toLowerCase().replace(/_/g, "-")}`,
		status,
	);
}

describe("0002_core_pipeline migration", () => {
	it("creates every M1 table", async () => {
		const { results } = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		).all<{ name: string }>();
		const names = results.map((r) => r.name);
		for (const t of TABLES) {
			expect(names).toContain(t);
		}
	});

	it("continues the NNNN_<topic>.sql sequence and never recreates settings", () => {
		const migrations = env.TEST_MIGRATIONS;
		expect(migrations.map((m) => m.name)).toEqual([
			expect.stringMatching(/^0001_settings/),
			expect.stringMatching(/^0002_core_pipeline/),
			expect.stringMatching(/^0003_collapse_duplicate_event_ids/),
			expect.stringMatching(/^0004_reliability/),
			expect.stringMatching(/^0005_admin_security/),
			expect.stringMatching(/^0006_dashboard/),
			expect.stringMatching(/^0007_limiter/),
			expect.stringMatching(/^0008_alerts/),
			expect.stringMatching(/^0009_archive/),
		]);
		const sql = migrations[1]?.queries.join("\n") ?? "";
		expect(sql).not.toMatch(/CREATE TABLE [`"]?settings/i);
		expect(sql).not.toMatch(/STRICT/);
	});

	it("rejects enum values outside the CHECK list", async () => {
		await expect(insertProject("prj_bad", "archived")).rejects.toThrow(
			/CHECK constraint failed/,
		);
	});

	it("requires secret_enc to be NULL exactly when auth_type is none", async () => {
		await insertProject("prj_chk");
		await exec(
			"INSERT INTO destinations (id, project_id, name, url, status, signing_secret_enc, created_at, updated_at) VALUES ('dst_chk', 'prj_chk', 'D', 'https://example.com', 'active', 'x', 1, 1)",
		);
		const insertSource = (
			id: string,
			authType: string,
			secret: string | null,
		) =>
			exec(
				"INSERT INTO sources (id, project_id, destination_id, name, status, auth_type, auth_config, secret_enc, event_id_from, created_at, updated_at) VALUES (?, 'prj_chk', 'dst_chk', 'S', 'active', ?, '{}', ?, 'none', 1, 1)",
				id,
				authType,
				secret,
			);
		await expect(insertSource("src_a", "none", "x")).rejects.toThrow(/CHECK/);
		await expect(insertSource("src_b", "hmac", null)).rejects.toThrow(/CHECK/);
		await expect(insertSource("src_c", "none", null)).resolves.toBeDefined();
	});

	it("requires event_id_selector exactly when event_id_from is not none", async () => {
		await insertProject("prj_eid");
		await exec(
			"INSERT INTO destinations (id, project_id, name, url, status, signing_secret_enc, created_at, updated_at) VALUES ('dst_eid', 'prj_eid', 'D', 'https://example.com', 'active', 'x', 1, 1)",
		);
		await expect(
			exec(
				"INSERT INTO sources (id, project_id, destination_id, name, status, auth_type, auth_config, event_id_from, event_id_selector, created_at, updated_at) VALUES ('src_e', 'prj_eid', 'dst_eid', 'S', 'active', 'none', '{}', 'header', NULL, 1, 1)",
			),
		).rejects.toThrow(/CHECK/);
	});

	it("enforces foreign keys", async () => {
		await expect(
			exec(
				"INSERT INTO destinations (id, project_id, name, url, status, signing_secret_enc, created_at, updated_at) VALUES ('dst_fk', 'prj_missing', 'D', 'https://example.com', 'active', 'x', 1, 1)",
			),
		).rejects.toThrow(/FOREIGN KEY/);
	});

	it("enforces one attempt number per delivery", async () => {
		const { results } = await env.DB.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'delivery_attempts'",
		).all<{ sql: string | null }>();
		expect(results.some((r) => /UNIQUE/i.test(r.sql ?? ""))).toBe(true);
	});
});

describe("enum parity between the DB schema and @hookflare/shared", () => {
	it("uses the same values", () => {
		expect(shared.PROJECT_STATUSES).toEqual(db.PROJECT_STATUSES);
		expect(shared.SOURCE_STATUSES).toEqual(db.SOURCE_STATUSES);
		expect(shared.AUTH_TYPES).toEqual(db.AUTH_TYPES);
		expect(shared.EVENT_ID_FROM).toEqual(db.EVENT_ID_FROM);
	});
});
