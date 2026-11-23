import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
	createOrphanFilter,
	orphanEntry,
	rowStatements,
	SqlFileWriter,
	tableOrder,
	utf8Length,
	valueLiteral,
} from "../lib/restore-sql.mjs";

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

	it("samples only the table, key and FK values of an orphan", () => {
		const filter = createOrphanFilter(pipelineManifest());
		filter.admit("projects", { id: "prj_1" });
		filter.admit("destinations", { id: "dst_1", project_id: "prj_1" });
		filter.admit("sources", {
			id: "src_1",
			project_id: "prj_1",
			destination_id: "dst_1",
		});
		assert.equal(
			filter.admit("webhook_events", {
				id: "evt_1",
				source_id: "src_gone",
				body_inline: { $b64: "c2VjcmV0" },
			}),
			false,
		);
		assert.deepEqual(filter.report().webhook_events, {
			count: 1,
			sample: [
				{
					table: "webhook_events",
					key: { id: "evt_1" },
					fk: { source_id: "src_gone" },
				},
			],
		});
	});

	it("matches parent keys on the FK's `to` column, not only the PK", () => {
		const manifest = {
			version: 1,
			backup_id: "b1",
			prefix: "p/",
			started_at: 1,
			finished_at: 2,
			d1_migrations: [],
			tables: [
				table("parents", { columns: ["id", "slug"] }),
				table("children", {
					columns: ["id", "parent_slug"],
					fks: [{ column: "parent_slug", table: "parents", to: "slug" }],
				}),
			],
		};
		const filter = createOrphanFilter(manifest);
		assert.equal(filter.admit("parents", { id: "p1", slug: "alpha" }), true);
		assert.equal(
			filter.admit("children", { id: "c1", parent_slug: "alpha" }),
			true,
		);
		assert.equal(
			filter.admit("children", { id: "c2", parent_slug: "p1" }),
			false,
		);
	});

	it("orphans a self-referencing subtree whose root was orphaned", () => {
		const manifest = {
			version: 1,
			backup_id: "b1",
			prefix: "p/",
			started_at: 1,
			finished_at: 2,
			d1_migrations: [],
			tables: [
				table("projects"),
				table("nodes", {
					columns: ["id", "code", "project_id", "parent_code"],
					fks: [
						{ column: "project_id", table: "projects", to: "id" },
						{ column: "parent_code", table: "nodes", to: "code" },
					],
				}),
			],
		};
		const filter = createOrphanFilter(manifest);
		filter.admit("projects", { id: "prj_1" });
		const rows = [
			{ id: "n3", code: "c3", project_id: "prj_1", parent_code: "c2" },
			{ id: "n2", code: "c2", project_id: "prj_1", parent_code: "c1" },
			{ id: "n1", code: "c1", project_id: "prj_gone", parent_code: null },
			{ id: "k2", code: "k2", project_id: "prj_1", parent_code: "k1" },
			{ id: "k1", code: "k1", project_id: "prj_1", parent_code: null },
			{ id: "y1", code: "y1", project_id: "prj_1", parent_code: "y2" },
			{ id: "y2", code: "y2", project_id: "prj_1", parent_code: "y1" },
			{ id: "m1", code: "m1", project_id: "prj_1", parent_code: "n1" },
		];
		filter.preload("nodes", rows);
		const admitted = rows.filter((r) => filter.admit("nodes", r));
		assert.deepEqual(
			admitted.map((r) => r.id),
			["k2", "k1", "y1", "y2"],
		);
		assert.equal(filter.report().nodes.count, 4);
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

function manifestOf(tables) {
	return {
		version: 1,
		backup_id: "b1",
		prefix: "p/",
		started_at: 1,
		finished_at: 2,
		d1_migrations: [],
		tables,
	};
}

describe("valueLiteral", () => {
	it("renders every supported cell type as SQL", () => {
		assert.equal(valueLiteral(null), "NULL");
		assert.equal(valueLiteral(undefined), "NULL");
		assert.equal(valueLiteral(-42), "-42");
		assert.equal(valueLiteral(9007199254740993n), "9007199254740993");
		assert.equal(valueLiteral(true), "1");
		assert.equal(valueLiteral(false), "0");
		assert.equal(valueLiteral("it's"), "'it''s'");
		assert.equal(valueLiteral({ $b64: "AP8Q" }), "X'00ff10'");
		assert.equal(valueLiteral({ $b64: "" }), "X''");
	});

	it("rejects non-integer numbers instead of losing precision", () => {
		assert.throws(() => valueLiteral(1.5), /restore: non-integer number 1\.5/);
		assert.throws(() => valueLiteral(Number.NaN), /non-integer number NaN/);
	});

	it("rejects values that are neither scalars nor $b64 cells", () => {
		assert.throws(
			() => valueLiteral({ nested: true }),
			/restore: unsupported value \{"nested":true\}/,
		);
		assert.throws(() => valueLiteral({ $b64: 1 }), /unsupported value/);
		assert.throws(
			() => valueLiteral(Symbol("x")),
			/restore: unsupported value undefined/,
		);
	});
});

describe("tableOrder cycle reporting", () => {
	it("names only the tables in the cycle, past acyclic branches", () => {
		const manifest = manifestOf([
			table("c", {
				fks: [
					{ column: "ok_id", table: "ok", to: "id" },
					{ column: "a_id", table: "a", to: "id" },
				],
			}),
			table("ok"),
			table("a", { fks: [{ column: "b_id", table: "b", to: "id" }] }),
			table("b", { fks: [{ column: "a_id", table: "a", to: "id" }] }),
		]);
		assert.throws(
			() => tableOrder(manifest),
			/^Error: restore: foreign key cycle: a -> b$/,
		);
	});

	it("ignores self references and FKs to tables outside the manifest", () => {
		const manifest = manifestOf([
			table("child", {
				fks: [
					{ column: "parent_id", table: "child", to: "id" },
					{ column: "ext_id", table: "elsewhere", to: "id" },
					{ column: "root_id", table: "root", to: "id" },
				],
			}),
			table("root"),
		]);
		assert.deepEqual(tableOrder(manifest), ["root", "child"]);
	});
});

describe("rowStatements limits and errors", () => {
	it("writes NULL for columns missing from the row and booleans as 0/1", () => {
		const t = table("flags", {
			columns: ["id", "enabled", "note"],
		});
		assert.deepEqual(rowStatements(t, { id: 7, enabled: true }), [
			'INSERT INTO "flags" ("id", "enabled", "note") VALUES (7, 1, NULL);',
		]);
	});

	it("quotes identifiers with embedded double quotes", () => {
		const t = table('we"ird', { columns: ['c"ol'] });
		assert.deepEqual(rowStatements(t, { 'c"ol': "v" }), [
			'INSERT INTO "we""ird" ("c""ol") VALUES (\'v\');',
		]);
	});

	it("throws for an oversized row in a rowid table", () => {
		const t = table("logs", { key: { rowid: true }, columns: ["msg"] });
		assert.throws(
			() => rowStatements(t, { msg: "x".repeat(200) }, 100),
			/restore: a row in logs is \d+ bytes and the table has no key column to split on/,
		);
	});

	it("throws when the row stays oversized after splitting every value", () => {
		const t = table("events", { columns: ["id", BODY] });
		assert.throws(
			() =>
				rowStatements(t, { id: "k".repeat(200), body: "b".repeat(50) }, 150),
			/restore: INSERT for events "id" = 'k+' is \d+ bytes even with every TEXT\/BLOB value split/,
		);
	});

	it("splits a TEXT value on an integer key with a WHERE on that key", () => {
		const t = table("events", { columns: ["id", BODY] });
		const body = "abcdefghijklmnopqrst";
		const stmts = rowStatements(t, { id: 12, body }, 70);
		assert.deepEqual(stmts, [
			'INSERT INTO "events" ("id", "body") VALUES (12, \'\');',
			'UPDATE "events" SET "body" = "body" || \'abcdefghijk\' WHERE "id" = 12;',
			'UPDATE "events" SET "body" = "body" || \'lmnopqrst\' WHERE "id" = 12;',
		]);
		assertUnder(stmts, 70);
		assert.equal(roundTrip(t, stmts).body, body);
	});

	it("throws when a BLOB append has no room for even one byte", () => {
		const t = table("b", { columns: ["id", DATA] });
		const max = 60;
		assert.ok(
			utf8Length('INSERT INTO "b" ("id", "data") VALUES (\'b1\', X\'\');') <
				max,
		);
		assert.throws(
			() => rowStatements(t, { id: "b1", data: { $b64: "A".repeat(80) } }, max),
			/restore: no room to append b\.data/,
		);
	});

	it("throws when a TEXT append has no room for a code point", () => {
		const t = table("b", { columns: ["id", BODY] });
		assert.throws(
			() => rowStatements(t, { id: "b1", body: "x".repeat(80) }, 55),
			/restore: no room to append b\.body/,
		);
	});
});

describe("utf8Length", () => {
	it("counts UTF-8 bytes", () => {
		assert.equal(utf8Length("a\u00e9\u6f22\u{1F600}"), 1 + 2 + 3 + 4);
	});
});

describe("orphanEntry", () => {
	it("uses a null key for rowid tables and null for missing FK values", () => {
		const t = table("logs", {
			key: { rowid: true },
			columns: ["msg", "project_id"],
			fks: [{ column: "project_id", table: "projects", to: "id" }],
		});
		assert.deepEqual(orphanEntry(t, { msg: "secret" }), {
			table: "logs",
			key: null,
			fk: { project_id: null },
		});
	});

	it("uses null for a missing key value", () => {
		assert.deepEqual(orphanEntry(table("projects"), {}), {
			table: "projects",
			key: { id: null },
			fk: {},
		});
	});
});

describe("createOrphanFilter edge cases", () => {
	it("throws for an unknown table name or a missing table", () => {
		const filter = createOrphanFilter(manifestOf([table("projects")]));
		assert.throws(
			() => filter.admit("nope", { id: 1 }),
			/restore: unknown table nope/,
		);
		assert.throws(
			() => filter.preload(undefined, []),
			/restore: unknown table \?/,
		);
	});

	it("accepts table objects and caps the orphan sample at five rows", () => {
		const projects = table("projects");
		const children = table("children", {
			columns: ["id", "project_id"],
			fks: [{ column: "project_id", table: "projects", to: "id" }],
		});
		const filter = createOrphanFilter(manifestOf([projects, children]));
		assert.equal(filter.admit(projects, { id: "p1" }), true);
		assert.equal(filter.admit(projects, { id: null }), true);
		assert.equal(filter.admit(children, { id: "c0", project_id: "p1" }), true);
		assert.equal(filter.admit(children, { id: "cn" }), true);
		for (let i = 1; i <= 7; i++) {
			assert.equal(
				filter.admit(children, { id: `c${i}`, project_id: "gone" }),
				false,
			);
		}
		const report = filter.report();
		assert.equal(report.children.count, 7);
		assert.deepEqual(
			report.children.sample.map((e) => e.key.id),
			["c1", "c2", "c3", "c4", "c5"],
		);
		assert.equal(report.projects, undefined);
	});

	it("filters a rowid table by its FK values, keyed by the whole row", () => {
		const projects = table("projects");
		const logs = table("logs", {
			key: { rowid: true },
			columns: ["msg", "project_id"],
			fks: [{ column: "project_id", table: "projects", to: "id" }],
		});
		const filter = createOrphanFilter(manifestOf([projects, logs]));
		filter.admit("projects", { id: "p1" });
		const rows = [
			{ msg: "kept", project_id: "p1" },
			{ msg: "dropped", project_id: "gone" },
			{ msg: "no project", project_id: null },
		];
		filter.preload("logs", rows);
		assert.deepEqual(
			rows.map((r) => filter.admit("logs", r)),
			[true, false, true],
		);
		assert.deepEqual(filter.report().logs, {
			count: 1,
			sample: [{ table: "logs", key: null, fk: { project_id: "gone" } }],
		});
	});

	it("treats rows missing the referenced column as owning nothing", () => {
		const nodes = table("nodes", {
			columns: ["id", "code", "parent_code"],
			fks: [{ column: "parent_code", table: "nodes", to: "code" }],
		});
		const filter = createOrphanFilter(manifestOf([nodes]));
		const rows = [
			{ id: "n1" },
			{ id: "n2", code: "c2", parent_code: "c2" },
			{ id: "n3", code: "c3", parent_code: "c2" },
		];
		filter.preload(nodes, rows.slice(0, 2));
		filter.preload(nodes, rows.slice(2));
		assert.deepEqual(
			rows.map((r) => filter.admit(nodes, r)),
			[true, true, true],
		);
		assert.equal(filter.admit(nodes, { id: "n4", parent_code: "c3" }), true);
		assert.equal(
			filter.admit(nodes, { id: "n5", code: "c5", parent_code: "c5" }),
			true,
		);
		assert.equal(filter.admit(nodes, { id: "n6", parent_code: "zz" }), false);
		assert.equal(filter.admit(nodes, { id: "n7", parent_code: "c7" }), false);
	});

	it("keys a preloaded row without its key column as null", () => {
		const nodes = table("nodes", {
			columns: ["id", "parent_id"],
			fks: [{ column: "parent_id", table: "nodes", to: "id" }],
		});
		const filter = createOrphanFilter(manifestOf([nodes]));
		filter.preload("nodes", [{ parent_id: null }]);
		assert.equal(filter.admit("nodes", { parent_id: null }), true);
		assert.deepEqual(filter.report(), {});
	});
});

describe("SqlFileWriter output", () => {
	it("starts each file with the defer pragma and adds one newline per statement", () => {
		const dir = mkdtempSync(join(tmpdir(), "restore-sql-"));
		try {
			const writer = new SqlFileWriter(join(dir, "nested", "sql"));
			writer.writeStatement("SELECT 1;");
			writer.writeStatement("SELECT 2;\n");
			const files = writer.close();
			assert.deepEqual(files, [join(dir, "nested", "sql", "0001.sql")]);
			assert.equal(
				readFileSync(files[0], "utf8"),
				"PRAGMA defer_foreign_keys = true;\nSELECT 1;\nSELECT 2;\n",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
