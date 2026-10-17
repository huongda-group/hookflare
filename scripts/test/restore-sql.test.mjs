import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
	createOrphanFilter,
	rowStatements,
	SqlFileWriter,
	tableOrder,
} from "../lib/restore-sql.mjs";

/** Minimal manifest table: key, columns, and FKs only. */
function table(
	name,
	{ key = { column: "id" }, columns = ["id"], fks = [] } = {},
) {
	return {
		name,
		key,
		columns: columns.map((c) =>
			typeof c === "string" ? { name: c, type: "TEXT", blob: false } : c,
		),
		foreign_keys: fks,
		rows: 0,
		parts: [],
	};
}

const BLOB = { name: "body_inline", type: "BLOB", blob: true };

function pipelineManifest() {
	return {
		version: 1,
		backup_id: "b1",
		prefix: "d1/2026/10/16/b1/",
		started_at: 1,
		finished_at: 2,
		d1_migrations: [],
		tables: [
			table("delivery_attempts", {
				columns: ["id", "delivery_id"],
				fks: [{ column: "delivery_id", table: "deliveries", to: "id" }],
			}),
			table("deliveries", {
				columns: ["id", "event_id", "destination_id"],
				fks: [
					{ column: "event_id", table: "webhook_events", to: "id" },
					{ column: "destination_id", table: "destinations", to: "id" },
				],
			}),
			table("webhook_events", {
				columns: ["id", "source_id", BLOB],
				fks: [{ column: "source_id", table: "sources", to: "id" }],
			}),
			table("sources", {
				columns: ["id", "project_id", "destination_id"],
				fks: [
					{ column: "project_id", table: "projects", to: "id" },
					{ column: "destination_id", table: "destinations", to: "id" },
				],
			}),
			table("destinations", {
				columns: ["id", "project_id"],
				fks: [{ column: "project_id", table: "projects", to: "id" }],
			}),
			table("projects"),
		],
	};
}

describe("tableOrder", () => {
	it("orders parents before children along the pipeline", () => {
		const order = tableOrder(pipelineManifest());
		const before = (a, b) => {
			assert.ok(
				order.indexOf(a) < order.indexOf(b),
				`expected ${a} before ${b}: ${order.join(",")}`,
			);
		};
		before("projects", "destinations");
		before("projects", "sources");
		before("projects", "webhook_events");
		before("webhook_events", "deliveries");
		before("deliveries", "delivery_attempts");
	});

	it("throws on a foreign key cycle", () => {
		const manifest = {
			version: 1,
			backup_id: "b1",
			prefix: "p/",
			started_at: 1,
			finished_at: 2,
			d1_migrations: [],
			tables: [
				table("a", { fks: [{ column: "b_id", table: "b", to: "id" }] }),
				table("b", { fks: [{ column: "a_id", table: "a", to: "id" }] }),
			],
		};
		assert.throws(() => tableOrder(manifest), /restore: foreign key cycle/);
	});
});

describe("rowStatements", () => {
	it("doubles single quotes in TEXT values", () => {
		const t = table("projects", { columns: ["id", "name"] });
		const [stmt] = rowStatements(t, { id: "p1", name: "O'Brien" });
		assert.match(stmt, /'O''Brien'/);
	});

	it("chunks a 64 KiB BLOB into 1 INSERT plus 2 UPDATEs", () => {
		const t = table("webhook_events", {
			columns: ["id", "source_id", BLOB],
			fks: [{ column: "source_id", table: "sources", to: "id" }],
		});
		const row = {
			id: "evt_1",
			source_id: "src_1",
			body_inline: { $b64: randomBytes(65536).toString("base64") },
		};
		const stmts = rowStatements(t, row);
		assert.equal(stmts.length, 3);
		assert.match(stmts[0], /INSERT INTO "webhook_events"/);
		assert.match(stmts[0], /X''/);
		for (const s of stmts) {
			assert.ok(
				Buffer.byteLength(s) < 90000,
				`statement is ${Buffer.byteLength(s)} bytes`,
			);
		}
	});
});

describe("createOrphanFilter", () => {
	it("drops a delivery with a missing event, then its attempts", () => {
		const filter = createOrphanFilter(pipelineManifest());
		assert.equal(filter.admit("projects", { id: "prj_1" }), true);
		assert.equal(
			filter.admit("destinations", { id: "dst_1", project_id: "prj_1" }),
			true,
		);
		assert.equal(
			filter.admit("sources", {
				id: "src_1",
				project_id: "prj_1",
				destination_id: "dst_1",
			}),
			true,
		);
		assert.equal(
			filter.admit("webhook_events", { id: "evt_1", source_id: "src_1" }),
			true,
		);
		assert.equal(
			filter.admit("deliveries", {
				id: "dlv_1",
				event_id: "evt_nope",
				destination_id: "dst_1",
			}),
			false,
		);
		assert.equal(
			filter.admit("deliveries", {
				id: "dlv_2",
				event_id: "evt_1",
				destination_id: "dst_1",
			}),
			true,
		);
		assert.equal(
			filter.admit("delivery_attempts", {
				id: "att_1",
				delivery_id: "dlv_1",
			}),
			false,
		);
		assert.equal(
			filter.admit("delivery_attempts", {
				id: "att_2",
				delivery_id: "dlv_2",
			}),
			true,
		);
		const report = filter.report();
		assert.equal(report.deliveries.count, 1);
		assert.equal(report.delivery_attempts.count, 1);
	});

	it("admits a forward self-reference after preloading keys", () => {
		const manifest = {
			version: 1,
			backup_id: "b1",
			prefix: "p/",
			started_at: 1,
			finished_at: 2,
			d1_migrations: [],
			tables: [
				table("nodes", {
					columns: ["id", "parent_id"],
					fks: [{ column: "parent_id", table: "nodes", to: "id" }],
				}),
			],
		};
		const filter = createOrphanFilter(manifest);
		const rows = [
			{ id: "child", parent_id: "parent" },
			{ id: "parent", parent_id: null },
		];
		filter.preload("nodes", rows);
		assert.equal(
			filter.admit("nodes", { id: "child", parent_id: "parent" }),
			true,
		);
		assert.equal(
			filter.admit("nodes", { id: "parent", parent_id: null }),
			true,
		);
		assert.equal(
			filter.admit("nodes", { id: "stray", parent_id: "missing" }),
			false,
		);
	});
});

/**
 * Apply statements to an in-memory SQLite table shaped like `t` and
 * return the stored row with `typeof` per column.
 */
function roundTrip(t, stmts) {
	const db = new DatabaseSync(":memory:");
	db.exec(
		`CREATE TABLE "${t.name}" (${t.columns.map((c) => `"${c.name}" ${c.type}${"column" in t.key && c.name === t.key.column ? " PRIMARY KEY" : ""}`).join(", ")})`,
	);
	for (const s of stmts) {
		db.exec(s);
	}
	const cols = t.columns
		.map((c) => `"${c.name}", typeof("${c.name}") AS "${c.name}__type"`)
		.join(", ");
	const rows = db.prepare(`SELECT ${cols} FROM "${t.name}"`).all();
	db.close();
	assert.equal(rows.length, 1);
	return rows[0];
}

function assertUnder(stmts, max = 90000) {
	for (const s of stmts) {
		assert.ok(
			Buffer.byteLength(s) < max,
			`statement is ${Buffer.byteLength(s)} bytes (max ${max})`,
		);
	}
}

const BODY = { name: "body", type: "TEXT", blob: false };
const DATA = { name: "data", type: "BLOB", blob: true };

describe("rowStatements byte limits", () => {
	const t = table("events", { columns: ["id", BODY, DATA] });

	it("measures UTF-8 bytes, not UTF-16 units, and splits CJK text", () => {
		// 40 000 CJK chars: 40 000 UTF-16 units, 120 000 UTF-8 bytes.
		const body = "漢".repeat(40000);
		const stmts = rowStatements(t, { id: "e1", body, data: null });
		assert.ok(stmts.length > 1, "expected the TEXT to be split");
		assertUnder(stmts);
		const got = roundTrip(t, stmts);
		assert.equal(got.body, body);
		assert.equal(got.body__type, "text");
		assert.equal(got.data__type, "null");
	});

	it("splits text made only of single quotes, measured after doubling", () => {
		const body = "'".repeat(60000);
		const stmts = rowStatements(t, { id: "e1", body, data: null });
		assert.ok(stmts.length > 1);
		assertUnder(stmts);
		assert.equal(roundTrip(t, stmts).body, body);
	});

	it("never splits an emoji across chunks", () => {
		const body = `x${"\u{1F600}".repeat(30000)}`;
		const stmts = rowStatements(t, { id: "e1", body, data: null });
		assertUnder(stmts);
		for (const s of stmts) {
			assert.ok(
				!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
					s,
				),
				"lone surrogate",
			);
		}
		assert.equal(roundTrip(t, stmts).body, body);
	});

	it("round-trips a BLOB of exactly 32 KiB and 32 KiB + 1 in oversized rows", () => {
		for (const n of [32768, 32769]) {
			const bytes = randomBytes(n);
			const row = {
				id: `e${n}`,
				body: "b".repeat(60000),
				data: { $b64: bytes.toString("base64") },
			};
			const stmts = rowStatements(t, row);
			assertUnder(stmts);
			const got = roundTrip(t, stmts);
			assert.equal(got.body, row.body);
			assert.equal(got.data__type, "blob");
			assert.deepEqual(Buffer.from(got.data), bytes);
		}
	});

	it("chunks a BLOB at exactly 32 KiB and 32 KiB + 1 bytes per UPDATE", () => {
		const blobOnly = table("b", { columns: ["id", DATA] });
		for (const [n, updates] of [
			[65536, 2],
			[65537, 3],
		]) {
			const bytes = randomBytes(n);
			const stmts = rowStatements(blobOnly, {
				id: "b1",
				data: { $b64: bytes.toString("base64") },
			});
			assert.equal(stmts.length, 1 + updates);
			assertUnder(stmts);
			assert.deepEqual(Buffer.from(roundTrip(blobOnly, stmts).data), bytes);
		}
	});

	it("keeps NULL, '' and X'' distinct in an oversized row", () => {
		const cols = [
			"id",
			BODY,
			{ name: "t_null", type: "TEXT", blob: false },
			{ name: "t_empty", type: "TEXT", blob: false },
			{ name: "b_null", type: "BLOB", blob: true },
			{ name: "b_empty", type: "BLOB", blob: true },
			DATA,
		];
		const wide = table("wide", { columns: cols });
		const big = randomBytes(70000);
		const row = {
			id: "w1",
			body: "z".repeat(50000),
			t_null: null,
			t_empty: "",
			b_null: null,
			b_empty: { $b64: "" },
			data: { $b64: big.toString("base64") },
		};
		const stmts = rowStatements(wide, row);
		assert.ok(stmts.length > 1);
		assertUnder(stmts);
		const got = roundTrip(wide, stmts);
		assert.equal(got.t_null__type, "null");
		assert.equal(got.t_empty__type, "text");
		assert.equal(got.t_empty, "");
		assert.equal(got.b_null__type, "null");
		assert.equal(got.b_empty__type, "blob");
		assert.equal(Buffer.from(got.b_empty).length, 0);
		assert.equal(got.body, row.body);
		assert.deepEqual(Buffer.from(got.data), big);
	});

	it("keeps every statement under a small custom limit", () => {
		const body = "\u{1F600}'é".repeat(5000);
		const stmts = rowStatements(t, { id: "e1", body, data: null }, 2000);
		assertUnder(stmts, 2000);
		assert.equal(roundTrip(t, stmts).body, body);
	});
});

describe("SqlFileWriter", () => {
	it("keeps every file at or under maxBytes, measured in UTF-8", () => {
		const dir = mkdtempSync(join(tmpdir(), "restore-sql-"));
		try {
			const writer = new SqlFileWriter(dir, 1000);
			for (let i = 0; i < 50; i++) {
				writer.writeStatement(`SELECT '${"漢".repeat(50)}';`);
			}
			const files = writer.close();
			assert.ok(files.length > 1);
			for (const f of files) {
				assert.ok(statSync(f).size <= 1000, `${f} is ${statSync(f).size}`);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
