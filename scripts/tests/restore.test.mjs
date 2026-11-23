import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
	backupIdOf,
	checkKnownDb,
	configDatabaseId,
	prepareMigrations,
	readPartRows,
	restoreBackup,
	sha256File,
	verifyChecks,
} from "../lib/restore.mjs";
import { repoRoot, wranglerBin } from "../lib/wrangler-bin.mjs";

const PROD_ID = "11111111-1111-1111-1111-111111111111";
const STAGING_ID = "22222222-2222-2222-2222-222222222222";
const TARGET_ID = "33333333-3333-3333-3333-333333333333";
const MIGRATIONS = ["0001_init.sql", "0002_items.sql"];
const PREFIX = "d1/2026/10/16/bk1/";

let dir;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "restore-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function config(name, id) {
	const path = join(dir, `${name}.jsonc`);
	writeFileSync(
		path,
		`{\n // ${name}\n "name": "${name}",\n "d1_databases": [{ "binding": "DB", "database_name": "${name}", "database_id": "${id}" }],\n}\n`,
	);
	return path;
}

function known() {
	return {
		productionConfig: config("prod", PROD_ID),
		stagingConfig: config("staging", STAGING_ID),
	};
}

function part(table, key, rows) {
	const body = gzipSync(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
	const blob_bytes = {};
	for (const row of rows) {
		for (const [col, v] of Object.entries(row)) {
			if (v && typeof v === "object" && "$b64" in v) {
				blob_bytes[col] =
					(blob_bytes[col] ?? 0) + Buffer.from(v.$b64, "base64").length;
			}
		}
	}
	return {
		entry: {
			table,
			key,
			rows: rows.length,
			bytes: body.length,
			sha256: createHash("sha256").update(body).digest("hex"),
			blob_bytes,
		},
		body,
	};
}

function backup({ itemRows } = {}) {
	const projects = part("projects", `${PREFIX}projects/0000.ndjson.gz`, [
		{ id: "prj_1" },
	]);
	const items = part(
		"items",
		`${PREFIX}items/0000.ndjson.gz`,
		itemRows ?? [
			{ id: "it_1", project_id: "prj_1", body: "ok", data: { $b64: "AAE=" } },
			{
				id: "it_2",
				project_id: "prj_gone",
				body: "top secret",
				data: { $b64: "AAECAw==" },
			},
		],
	);
	const manifest = {
		version: 1,
		backup_id: "bk1",
		prefix: PREFIX,
		started_at: 1,
		finished_at: 2,
		d1_migrations: MIGRATIONS,
		tables: [
			{
				name: "items",
				key: { column: "id" },
				columns: [
					{ name: "id", type: "TEXT", blob: false },
					{ name: "project_id", type: "TEXT", blob: false },
					{ name: "body", type: "TEXT", blob: false },
					{ name: "data", type: "BLOB", blob: true },
				],
				foreign_keys: [{ column: "project_id", table: "projects", to: "id" }],
				rows: items.entry.rows,
				parts: [items.entry],
			},
			{
				name: "projects",
				key: { column: "id" },
				columns: [{ name: "id", type: "TEXT", blob: false }],
				foreign_keys: [],
				rows: 1,
				parts: [projects.entry],
			},
		],
	};
	const bucket = new Map([
		[`${PREFIX}manifest.json`, Buffer.from(JSON.stringify(manifest))],
		[projects.entry.key, projects.body],
		[items.entry.key, items.body],
	]);
	return { manifest, bucket };
}

function targetDb(migrations = MIGRATIONS) {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);
		CREATE TABLE projects (id TEXT PRIMARY KEY);
		CREATE TABLE items (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), body TEXT, data BLOB);
	`);
	for (const m of migrations) {
		db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(m);
	}
	return db;
}

function deps(bucket, db, { failOn } = {}) {
	const executed = [];
	return {
		executed,
		r2Get: async (key, dest) => {
			const body = bucket.get(key);
			if (!body) {
				throw new Error(`no such key ${key}`);
			}
			mkdirSync(dirname(dest), { recursive: true });
			writeFileSync(dest, body);
		},
		query: async (sql) => db.prepare(sql).all(),
		execute: async (file) => {
			const name = file.split("/").pop();
			if (failOn?.has(name)) {
				failOn.delete(name);
				throw new Error(`boom in ${name}`);
			}
			db.exec(`BEGIN;\n${readFileSync(file, "utf8")}\nCOMMIT;`);
			executed.push(name);
		},
		log: () => {},
	};
}

function options(extra = {}) {
	return {
		prefix: PREFIX,
		config: config("target", TARGET_ID),
		dryRun: false,
		allowKnownDb: false,
		from: null,
		cwd: dir,
		...known(),
		...extra,
	};
}

describe("wranglerBin", () => {
	it("prefers node_modules/.bin/wrangler under the repo root", () => {
		assert.equal(
			wranglerBin("/repo", () => true),
			join("/repo", "node_modules", ".bin", "wrangler"),
		);
	});

	it("resolves wrangler.cmd on Windows", (t) => {
		t.mock.property(process, "platform", "win32");
		const checked = [];
		assert.equal(
			wranglerBin("/repo", (path) => {
				checked.push(path);
				return true;
			}),
			join("/repo", "node_modules", ".bin", "wrangler.cmd"),
		);
		assert.deepEqual(checked, [
			join("/repo", "node_modules", ".bin", "wrangler.cmd"),
		]);
	});

	it("defaults to the repository root next to scripts/", () => {
		assert.equal(
			wranglerBin(undefined, () => true),
			join(repoRoot, "node_modules", ".bin", "wrangler"),
		);
		assert.equal(
			repoRoot,
			join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
		);
	});

	it("falls back to wrangler on PATH", () => {
		assert.equal(
			wranglerBin("/repo", () => false),
			"wrangler",
		);
	});
});

describe("checkKnownDb", () => {
	it("never allows the production database, even with --allow-known-db", () => {
		const k = known();
		const target = config("t", PROD_ID);
		for (const allowKnownDb of [false, true]) {
			assert.throws(
				() => checkKnownDb({ config: target, allowKnownDb, ...k }),
				/production database/,
			);
		}
	});

	it("requires --allow-known-db for the staging database", () => {
		const k = known();
		const target = config("t", STAGING_ID);
		assert.throws(
			() => checkKnownDb({ config: target, allowKnownDb: false, ...k }),
			/--allow-known-db/,
		);
		checkKnownDb({ config: target, allowKnownDb: true, ...k });
	});

	it("allows any other database", () => {
		checkKnownDb({
			config: config("t", TARGET_ID),
			allowKnownDb: false,
			...known(),
		});
	});
});

describe("readPartRows", () => {
	it("streams rows from a gzipped NDJSON part", async () => {
		const path = join(dir, "p.ndjson.gz");
		writeFileSync(path, gzipSync('{"id":1}\n\n{"id":2}\n'));
		const rows = [];
		for await (const r of readPartRows(path)) {
			rows.push(r);
		}
		assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
	});

	it("rejects a corrupt part", async () => {
		const path = join(dir, "p.ndjson.gz");
		writeFileSync(path, Buffer.from("not gzip at all"));
		await assert.rejects(async () => {
			for await (const _ of readPartRows(path)) {
			}
		});
	});
});

describe("restoreBackup", () => {
	it("restores rows, writes key-only orphans.json and applied.json", async () => {
		const { bucket } = backup();
		const db = targetDb();
		const d = deps(bucket, db);
		const result = await restoreBackup(options(), d);
		assert.deepEqual(
			db
				.prepare("SELECT id FROM items")
				.all()
				.map((r) => r.id),
			["it_1"],
		);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get().n, 1);
		const out = join(dir, ".restore", "bk1");
		const orphans = JSON.parse(readFileSync(join(out, "orphans.json"), "utf8"));
		assert.deepEqual(orphans.items, {
			count: 1,
			sample: [
				{ table: "items", key: { id: "it_2" }, fk: { project_id: "prj_gone" } },
			],
			blob_bytes: { data: 4 },
		});
		assert.ok(
			!readFileSync(join(out, "orphans.json"), "utf8").includes("secret"),
		);
		const applied = JSON.parse(readFileSync(join(out, "applied.json"), "utf8"));
		assert.equal(applied.database_id, TARGET_ID);
		assert.deepEqual(
			applied.files.map((f) => f.name),
			result.files.map((f) => f.split("/").pop()),
		);
	});

	it("refuses a non-empty target", async () => {
		const { bucket } = backup();
		const db = targetDb();
		db.exec("INSERT INTO projects VALUES ('prj_x')");
		const d = deps(bucket, db);
		await assert.rejects(restoreBackup(options(), d), /not empty.*projects=1/);
		assert.deepEqual(d.executed, []);
	});

	it("refuses when target migrations differ from the manifest", async () => {
		const { bucket } = backup();
		const db = targetDb(["0001_init.sql", "0002_items.sql", "0003_new.sql"]);
		const d = deps(bucket, db);
		await assert.rejects(
			restoreBackup(options(), d),
			/d1_migrations.*0003_new\.sql/s,
		);
		assert.deepEqual(d.executed, []);
	});

	it("refuses the production database before touching anything", async () => {
		const { bucket } = backup();
		const d = deps(bucket, targetDb());
		await assert.rejects(
			restoreBackup(options({ config: config("t", PROD_ID) }), d),
			/production database/,
		);
		assert.deepEqual(d.executed, []);
	});

	it("does not query or apply on --dry-run", async () => {
		const { bucket } = backup();
		const d = deps(bucket, targetDb());
		d.query = async () => {
			throw new Error("queried");
		};
		const result = await restoreBackup(options({ dryRun: true }), d);
		assert.ok(result.files.length > 0);
		assert.deepEqual(d.executed, []);
	});

	it("stops at the failing file and resumes from it on re-run", async () => {
		const rows = [];
		for (let i = 0; i < 40; i++) {
			rows.push({
				id: `it_${i}`,
				project_id: "prj_1",
				body: "x".repeat(400),
				data: null,
			});
		}
		const { bucket } = backup({ itemRows: rows });
		const db = targetDb();
		const d = deps(bucket, db, { failOn: new Set(["0003.sql"]) });
		const opts = options({ maxFileBytes: 4000 });
		const logs = [];
		d.log = (m) => logs.push(m);
		await assert.rejects(restoreBackup(opts, d), /boom in 0003\.sql/);
		assert.deepEqual(d.executed, ["0001.sql", "0002.sql"]);
		assert.ok(
			logs.some((m) => /stopped at 0003\.sql/.test(m)),
			logs.join("\n"),
		);
		await restoreBackup(opts, d);
		assert.equal(d.executed.filter((n) => n === "0001.sql").length, 1);
		assert.equal(d.executed.filter((n) => n === "0003.sql").length, 1);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items").get().n, 40);
	});

	it("refuses to resume into a different database", async () => {
		const { bucket } = backup();
		const db = targetDb();
		await restoreBackup(options({ dryRun: false }), deps(bucket, db));
		await assert.rejects(
			restoreBackup(
				options({
					config: config("other", "44444444-4444-4444-4444-444444444444"),
				}),
				deps(bucket, targetDb()),
			),
			/applied\.json.*33333333/s,
		);
	});

	it("skips files before --from", async () => {
		const { bucket } = backup();
		const db = targetDb();
		db.exec("INSERT INTO projects VALUES ('prj_1')");
		const d = deps(bucket, db);
		const result = await restoreBackup(
			options({ from: 2, maxFileBytes: 60 }),
			d,
		);
		assert.ok(result.files.length > 1);
		assert.ok(!d.executed.includes("0001.sql"));
	});

	it("restores a self-referencing table with forward references", async () => {
		const nodes = part("nodes", `${PREFIX}nodes/0000.ndjson.gz`, [
			{ id: "n2", parent_id: "n1" },
			{ id: "n1", parent_id: null },
			{ id: "n3", parent_id: "gone" },
			{ id: "n4", parent_id: "n3" },
		]);
		const manifest = {
			version: 1,
			backup_id: "bk1",
			prefix: PREFIX,
			started_at: 1,
			finished_at: 2,
			d1_migrations: MIGRATIONS,
			tables: [
				{
					name: "nodes",
					key: { column: "id" },
					columns: [
						{ name: "id", type: "TEXT", blob: false },
						{ name: "parent_id", type: "TEXT", blob: false },
					],
					foreign_keys: [{ column: "parent_id", table: "nodes", to: "id" }],
					rows: 4,
					parts: [nodes.entry],
				},
			],
		};
		const bucket = new Map([
			[`${PREFIX}manifest.json`, Buffer.from(JSON.stringify(manifest))],
			[nodes.entry.key, nodes.body],
		]);
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);
			CREATE TABLE nodes (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES nodes(id));
			INSERT INTO d1_migrations (name) VALUES ('0001_init.sql'), ('0002_items.sql');
		`);
		await restoreBackup(options(), deps(bucket, db));
		assert.deepEqual(
			db
				.prepare("SELECT id FROM nodes ORDER BY id")
				.all()
				.map((r) => r.id),
			["n1", "n2"],
		);
	});
});

describe("verifyChecks", () => {
	it("reports a manifest whose table rows differ from its parts", async () => {
		const { manifest } = backup();
		manifest.tables[0].rows = 5;
		const db = targetDb();
		const checks = await verifyChecks({
			manifest,
			orphans: {},
			query: async (sql) => db.prepare(sql).all(),
		});
		const bad = checks.find((c) => c.check === "manifest rows items");
		assert.ok(bad, checks.map((c) => c.check).join(","));
		assert.equal(bad.ok, false);
		assert.equal(bad.expected, "2");
		assert.equal(bad.actual, "5");
	});

	it("passes on a clean restore", async () => {
		const { bucket, manifest } = backup();
		const db = targetDb();
		await restoreBackup(options(), deps(bucket, db));
		const orphans = JSON.parse(
			readFileSync(join(dir, ".restore", "bk1", "orphans.json"), "utf8"),
		);
		const checks = await verifyChecks({
			manifest,
			orphans,
			query: async (sql) => db.prepare(sql).all(),
		});
		assert.deepEqual(
			checks.filter((c) => !c.ok),
			[],
		);
	});
});

describe("prepareMigrations", () => {
	it("copies exactly the manifest's migrations", () => {
		const src = join(dir, "migrations");
		mkdirSync(src);
		for (const m of [...MIGRATIONS, "0003_later.sql"]) {
			writeFileSync(join(src, m), `-- ${m}`);
		}
		const out = join(dir, "subset");
		prepareMigrations({ d1_migrations: MIGRATIONS }, src, out);
		assert.deepEqual(readdirSync(out).sort(), MIGRATIONS);
	});

	it("refuses when a listed migration is missing from the repo", () => {
		const src = join(dir, "migrations");
		mkdirSync(src);
		writeFileSync(join(src, MIGRATIONS[0]), "--");
		assert.throws(
			() =>
				prepareMigrations({ d1_migrations: MIGRATIONS }, src, join(dir, "o")),
			/0002_items\.sql/,
		);
		assert.ok(!existsSync(join(dir, "o", MIGRATIONS[0])));
	});
});

describe("backupIdOf", () => {
	it("returns the last non-empty prefix segment", () => {
		assert.equal(backupIdOf(PREFIX), "bk1");
		assert.equal(backupIdOf("d1/2026/10/16/bk2"), "bk2");
	});

	it("rejects a prefix without segments", () => {
		assert.throws(() => backupIdOf("//"), /restore: bad prefix \/\//);
		assert.throws(() => backupIdOf(""), /restore: bad prefix/);
	});
});

describe("configDatabaseId", () => {
	function raw(body) {
		const path = join(dir, "raw.jsonc");
		writeFileSync(path, body);
		return path;
	}

	it("prefers the DB binding over other D1 databases", () => {
		assert.equal(
			configDatabaseId(
				raw(
					'{"d1_databases": [{"binding": "OTHER", "database_id": "x"}, {"binding": "DB", "database_id": "y"}]}',
				),
			),
			"y",
		);
	});

	it("falls back to the only D1 database when none is bound as DB", () => {
		assert.equal(
			configDatabaseId(
				raw('{"d1_databases": [{"binding": "MAIN", "database_id": 42}]}'),
			),
			"42",
		);
	});

	it("throws when the config has no usable database_id", () => {
		for (const body of [
			"{}",
			'{"d1_databases": {}}',
			'{"d1_databases": []}',
			'{"d1_databases": [{"binding": "DB", "database_id": ""}]}',
		]) {
			const path = raw(body);
			assert.throws(
				() => configDatabaseId(path),
				new RegExp(`restore: ${path} has no D1 database_id`),
			);
		}
	});
});

describe("sha256File", () => {
	it("hashes the file contents", async () => {
		const path = join(dir, "f.bin");
		writeFileSync(path, "hello");
		assert.equal(
			await sha256File(path),
			createHash("sha256").update("hello").digest("hex"),
		);
	});
});

describe("readPartRows without a trailing newline", () => {
	it("yields the final unterminated line", async () => {
		const path = join(dir, "p.ndjson.gz");
		writeFileSync(path, gzipSync('{"id":1}\n{"id":2}'));
		const rows = [];
		for await (const r of readPartRows(path)) {
			rows.push(r);
		}
		assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
	});
});

describe("restoreBackup guards and resume safety", () => {
	it("rejects an unsupported manifest version before querying", async () => {
		const { manifest } = backup();
		const bucket = new Map([
			[
				`${PREFIX}manifest.json`,
				Buffer.from(JSON.stringify({ ...manifest, version: 2 })),
			],
		]);
		const d = deps(bucket, targetDb());
		d.query = async () => {
			throw new Error("queried");
		};
		await assert.rejects(
			restoreBackup(options(), d),
			/restore: unsupported manifest version 2/,
		);
	});

	it("reports missing target migrations with a dash for no extras", async () => {
		const { bucket } = backup();
		const d = deps(bucket, targetDb(["0001_init.sql"]));
		await assert.rejects(restoreBackup(options(), d), (err) => {
			assert.match(err.message, /missing on target: 0002_items\.sql/);
			assert.match(err.message, /extra on target: {3}-/);
			return true;
		});
		assert.deepEqual(d.executed, []);
	});

	it("rejects a part whose download does not match the manifest sha256", async () => {
		const { bucket, manifest } = backup();
		const key = manifest.tables[0].parts[0].key;
		bucket.set(key, gzipSync("tampered\n"));
		const d = deps(bucket, targetDb());
		await assert.rejects(
			restoreBackup(options(), d),
			new RegExp(
				`restore: sha256 mismatch for ${key}: manifest ${manifest.tables[0].parts[0].sha256}, got [0-9a-f]{64}`,
			),
		);
		assert.deepEqual(d.executed, []);
	});

	it("reuses verified local parts and re-downloads corrupt ones", async () => {
		const { bucket, manifest } = backup();
		const out = join(dir, ".restore", "bk1");
		const [itemsKey, projectsKey] = manifest.tables.map((t) => t.parts[0].key);
		mkdirSync(dirname(join(out, itemsKey)), { recursive: true });
		mkdirSync(dirname(join(out, projectsKey)), { recursive: true });
		writeFileSync(join(out, itemsKey), bucket.get(itemsKey));
		writeFileSync(join(out, projectsKey), "corrupt");
		const d = deps(bucket, targetDb());
		const logs = [];
		d.log = (m) => logs.push(m);
		await restoreBackup(options({ dryRun: true }), d);
		const downloads = logs.filter((m) => m.startsWith("restore: downloading"));
		assert.deepEqual(downloads, [
			`restore: downloading ${PREFIX}manifest.json`,
			`restore: downloading ${projectsKey}`,
		]);
		assert.ok(logs.includes("restore: --dry-run, nothing applied"));
		assert.ok(logs.includes("restore: items: 1 orphaned row(s) skipped"));
	});

	it("refuses to resume when a regenerated file differs from applied.json", async () => {
		const { bucket } = backup();
		const db = targetDb();
		await restoreBackup(options(), deps(bucket, db));
		const appliedPath = join(dir, ".restore", "bk1", "applied.json");
		const applied = JSON.parse(readFileSync(appliedPath, "utf8"));
		applied.files[0].sha256 = "0".repeat(64);
		writeFileSync(appliedPath, JSON.stringify(applied));
		const d = deps(bucket, db);
		await assert.rejects(
			restoreBackup(options(), d),
			/restore: 0001\.sql differs from the file recorded in .*applied\.json; .*resuming is unsafe/,
		);
		assert.deepEqual(d.executed, []);
	});

	it("skips the emptiness query for a manifest without tables", async () => {
		const manifest = {
			version: 1,
			backup_id: "bk1",
			prefix: PREFIX,
			started_at: 1,
			finished_at: 2,
			d1_migrations: MIGRATIONS,
			tables: [],
		};
		const bucket = new Map([
			[`${PREFIX}manifest.json`, Buffer.from(JSON.stringify(manifest))],
		]);
		const queries = [];
		const db = targetDb();
		const d = deps(bucket, db);
		d.query = async (sql) => {
			queries.push(sql);
			return db.prepare(sql).all();
		};
		const result = await restoreBackup(options(), d);
		assert.deepEqual(queries, ["SELECT name FROM d1_migrations ORDER BY id"]);
		assert.deepEqual(result.files, []);
		assert.deepEqual(result.orphans, {});
	});

	it("treats an empty or NULL count result as an empty target", async () => {
		const { bucket } = backup();
		const db = targetDb();
		for (const counts of [[], [{ items: null, projects: 0 }]]) {
			rmSync(join(dir, ".restore"), { recursive: true, force: true });
			const d = deps(bucket, db);
			d.query = async (sql) =>
				sql.startsWith("SELECT (SELECT COUNT") ? counts : db.prepare(sql).all();
			await restoreBackup(options({ dryRun: false }), d);
			assert.ok(d.executed.length > 0);
			db.exec("DELETE FROM items; DELETE FROM projects;");
		}
	});

	it("preloads a large self-referencing part in batches and sizes orphan blobs", async () => {
		const rows = [];
		for (let i = 0; i < 1005; i++) {
			rows.push({ id: `n${i}`, parent_id: i === 0 ? null : `n${i - 1}` });
		}
		rows[0].parent_id = "n1004";
		rows.push(
			{ id: "o1", parent_id: "gone", data: { $b64: "AA==" } },
			{ id: "o2", parent_id: "gone", data: { $b64: "AAA=" } },
			{ id: "o3", parent_id: "gone", data: { $b64: "AAAA" } },
			{ id: "o4", parent_id: "gone", data: null },
		);
		const nodes = part("nodes", `${PREFIX}nodes/0000.ndjson.gz`, rows);
		const manifest = {
			version: 1,
			backup_id: "bk1",
			prefix: PREFIX,
			started_at: 1,
			finished_at: 2,
			d1_migrations: MIGRATIONS,
			tables: [
				{
					name: "nodes",
					key: { column: "id" },
					columns: [
						{ name: "id", type: "TEXT", blob: false },
						{ name: "parent_id", type: "TEXT", blob: false },
						{ name: "data", type: "BLOB", blob: true },
					],
					foreign_keys: [{ column: "parent_id", table: "nodes", to: "id" }],
					rows: rows.length,
					parts: [nodes.entry],
				},
			],
		};
		const bucket = new Map([
			[`${PREFIX}manifest.json`, Buffer.from(JSON.stringify(manifest))],
			[nodes.entry.key, nodes.body],
		]);
		const result = await restoreBackup(
			options({ dryRun: true }),
			deps(bucket, targetDb()),
		);
		assert.deepEqual(result.orphans, {
			nodes: {
				count: 4,
				sample: ["o1", "o2", "o3", "o4"].map((id) => ({
					table: "nodes",
					key: { id },
					fk: { parent_id: "gone" },
				})),
				blob_bytes: { data: 1 + 2 + 3 },
			},
		});
	});
});

describe("verifyChecks edge cases", () => {
	it("reports a failing integrity check and missing count rows", async () => {
		const { manifest } = backup();
		delete manifest.tables[0].parts[0].blob_bytes;
		const answers = new Map([
			["PRAGMA integrity_check", [{ x: "row 1 missing" }, { x: "row 2" }]],
			["PRAGMA foreign_key_check", []],
			["SELECT name FROM d1_migrations ORDER BY id", [{ name: MIGRATIONS[0] }]],
		]);
		const checks = await verifyChecks({
			manifest,
			orphans: { items: { count: 1 } },
			query: async (sql) => answers.get(sql) ?? [],
		});
		const byName = Object.fromEntries(checks.map((c) => [c.check, c]));
		assert.deepEqual(byName.integrity_check, {
			check: "integrity_check",
			expected: '"ok"',
			actual: '[{"x":"row 1 missing"},{"x":"row 2"}]',
			ok: false,
		});
		assert.equal(byName["rows items"].expected, "1");
		assert.equal(byName["rows items"].actual, "null");
		assert.equal(byName["rows projects"].expected, "1");
		assert.deepEqual(byName["blob_bytes items.data"], {
			check: "blob_bytes items.data",
			expected: "0",
			actual: "0",
			ok: true,
		});
		assert.equal(byName.d1_migrations.ok, false);
		assert.equal(byName.foreign_key_check.ok, true);
	});
});
