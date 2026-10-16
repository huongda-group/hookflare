import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
	createOrphanFilter,
	rowStatements,
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
});
