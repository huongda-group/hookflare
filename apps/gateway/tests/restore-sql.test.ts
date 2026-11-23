import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rowStatements } from "../../../scripts/lib/restore-sql.mjs";

const COLUMNS = [
	{ name: "id", type: "TEXT", blob: false },
	{ name: "project_id", type: "TEXT", blob: false },
	{ name: "source_id", type: "TEXT", blob: false },
	{ name: "provider_event_id", type: "TEXT", blob: false },
	{ name: "received_at", type: "INTEGER", blob: false },
	{ name: "headers_json", type: "TEXT", blob: false },
	{ name: "content_type", type: "TEXT", blob: false },
	{ name: "size_bytes", type: "INTEGER", blob: false },
	{ name: "payload_sha256", type: "TEXT", blob: false },
	{ name: "body_inline", type: "BLOB", blob: true },
	{ name: "r2_key", type: "TEXT", blob: false },
	{ name: "archive_batch_id", type: "TEXT", blob: false },
	{ name: "archive_part", type: "INTEGER", blob: false },
];

describe("restore-sql", () => {
	it("round-trips a 64 KiB blob through the generated SQL", async () => {
		await env.DB.prepare("DROP TABLE IF EXISTS t_restore").run();
		try {
			await env.DB.prepare(
				"CREATE TABLE t_restore AS SELECT * FROM webhook_events WHERE 0",
			).run();
			const bytes = crypto.getRandomValues(new Uint8Array(65536));
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000) {
				bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			}
			const table = {
				name: "t_restore",
				key: { column: "id" },
				columns: COLUMNS,
				foreign_keys: [],
				rows: 1,
				parts: [],
			};
			const row = {
				id: "evt_restore_1",
				project_id: "prj_restore",
				source_id: "src_restore",
				provider_event_id: null,
				received_at: 1760000000,
				headers_json: "{}",
				content_type: "application/json",
				size_bytes: 65536,
				payload_sha256: "abc",
				body_inline: { $b64: btoa(bin) },
				r2_key: null,
				archive_batch_id: null,
				archive_part: null,
			};
			const stmts = rowStatements(table, row);
			expect(stmts.length).toBe(3);
			for (const s of stmts) {
				await env.DB.prepare(s).run();
			}
			const got = await env.DB.prepare(
				"SELECT typeof(body_inline) AS t, body_inline AS b FROM t_restore WHERE id = 'evt_restore_1'",
			).first<{ t: string; b: ArrayBuffer }>();
			expect(got?.t).toBe("blob");
			expect(new Uint8Array(got?.b ?? new ArrayBuffer(0))).toEqual(bytes);
		} finally {
			await env.DB.prepare("DROP TABLE IF EXISTS t_restore").run();
		}
	});
});
