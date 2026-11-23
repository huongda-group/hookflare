import { createHash } from "node:crypto";
import {
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import { parseJsonc } from "./jsonc.mjs";
import {
	createOrphanFilter,
	rowStatements,
	SqlFileWriter,
	tableOrder,
} from "./restore-sql.mjs";

const PRELOAD_BATCH = 1000;

export function backupIdOf(prefix) {
	const segments = prefix.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) {
		throw new Error(`restore: bad prefix ${prefix}`);
	}
	return segments[segments.length - 1];
}

function ident(s) {
	return `"${s.replace(/"/g, '""')}"`;
}

export function configDatabaseId(path) {
	const config = parseJsonc(readFileSync(path, "utf8"));
	const dbs = Array.isArray(config.d1_databases) ? config.d1_databases : [];
	const db = dbs.find((d) => d.binding === "DB") ?? dbs[0];
	if (!db?.database_id) {
		throw new Error(`restore: ${path} has no D1 database_id`);
	}
	return String(db.database_id);
}

export function checkKnownDb({
	config,
	allowKnownDb,
	productionConfig,
	stagingConfig,
}) {
	const target = configDatabaseId(config);
	if (target === configDatabaseId(productionConfig)) {
		throw new Error(
			`restore: ${config} points at the production database (${target}); restore into a new database instead`,
		);
	}
	if (target === configDatabaseId(stagingConfig) && !allowKnownDb) {
		throw new Error(
			`restore: ${config} points at the staging database (${target}); pass --allow-known-db to restore into it`,
		);
	}
}

export async function sha256File(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

export async function* readPartRows(path) {
	const gunzip = pipeline(createReadStream(path), createGunzip(), () => {});
	gunzip.setEncoding("utf8");
	let rest = "";
	for await (const chunk of gunzip) {
		const lines = (rest + chunk).split("\n");
		/* node:coverage ignore next */
		rest = lines.pop() ?? "";
		for (const line of lines) {
			if (line.length > 0) {
				yield JSON.parse(line);
			}
		}
	}
	if (rest.length > 0) {
		yield JSON.parse(rest);
	}
}

function rowBlobBytes(table, row) {
	const out = {};
	for (const c of table.columns) {
		if (!c.blob) {
			continue;
		}
		const value = row[c.name] ?? null;
		if (typeof value === "object" && value !== null && "$b64" in value) {
			const b64 = value.$b64;
			const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
			out[c.name] = (b64.length * 3) / 4 - pad;
		}
	}
	return out;
}

async function downloadParts(manifest, outDir, deps) {
	for (const table of manifest.tables) {
		for (const part of table.parts) {
			const local = join(outDir, part.key);
			if (existsSync(local) && (await sha256File(local)) === part.sha256) {
				continue;
			}
			deps.log(`restore: downloading ${part.key}`);
			await deps.r2Get(part.key, local);
			const actual = await sha256File(local);
			if (actual !== part.sha256) {
				throw new Error(
					`restore: sha256 mismatch for ${part.key}: manifest ${part.sha256}, got ${actual}`,
				);
			}
		}
	}
}

async function generateSql(manifest, outDir, maxFileBytes) {
	const sqlDir = join(outDir, "sql");
	rmSync(sqlDir, { recursive: true, force: true });
	const writer = new SqlFileWriter(sqlDir, maxFileBytes);
	const filter = createOrphanFilter(manifest);
	const orphanBlobs = {};
	const byName = new Map(manifest.tables.map((t) => [t.name, t]));
	for (const name of tableOrder(manifest)) {
		const table = byName.get(name);
		if (table.foreign_keys.some((fk) => fk.table === table.name)) {
			for (const part of table.parts) {
				let batch = [];
				for await (const row of readPartRows(join(outDir, part.key))) {
					batch.push(row);
					if (batch.length >= PRELOAD_BATCH) {
						filter.preload(table, batch);
						batch = [];
					}
				}
				filter.preload(table, batch);
			}
		}
		for (const part of table.parts) {
			for await (const row of readPartRows(join(outDir, part.key))) {
				if (!filter.admit(table, row)) {
					const blobs = orphanBlobs[table.name] ?? {};
					orphanBlobs[table.name] = blobs;
					for (const [col, n] of Object.entries(rowBlobBytes(table, row))) {
						blobs[col] = (blobs[col] ?? 0) + n;
					}
					continue;
				}
				for (const stmt of rowStatements(table, row)) {
					writer.writeStatement(stmt);
				}
			}
		}
	}
	const orphans = {};
	for (const [name, entry] of Object.entries(filter.report())) {
		/* node:coverage ignore next */
		orphans[name] = { ...entry, blob_bytes: orphanBlobs[name] ?? {} };
	}
	writeFileSync(
		join(outDir, "orphans.json"),
		`${JSON.stringify(orphans, null, 2)}\n`,
	);
	return { files: writer.close(), orphans };
}

async function checkMigrations(manifest, deps) {
	const rows = await deps.query("SELECT name FROM d1_migrations ORDER BY id");
	const applied = rows.map((r) => String(r.name));
	if (JSON.stringify(applied) !== JSON.stringify(manifest.d1_migrations)) {
		const missing = manifest.d1_migrations.filter((m) => !applied.includes(m));
		const extra = applied.filter((m) => !manifest.d1_migrations.includes(m));
		throw new Error(
			[
				"restore: target d1_migrations do not match the backup manifest",
				`  missing on target: ${missing.join(", ") || "-"}`,
				`  extra on target:   ${extra.join(", ") || "-"}`,
				"  apply exactly the manifest's migrations first (see --prepare-migrations)",
			].join("\n"),
		);
	}
}

async function checkEmpty(manifest, deps) {
	if (manifest.tables.length === 0) {
		return;
	}
	const counts = manifest.tables
		.map((t) => `(SELECT COUNT(*) FROM ${ident(t.name)}) AS ${ident(t.name)}`)
		.join(", ");
	const [row] = await deps.query(`SELECT ${counts}`);
	const nonEmpty = manifest.tables
		.filter((t) => Number(row?.[t.name] ?? 0) !== 0)
		.map((t) => `${t.name}=${row[t.name]}`);
	if (nonEmpty.length > 0) {
		throw new Error(
			`restore: target database is not empty (${nonEmpty.join(", ")}); restore into a new database`,
		);
	}
}

export async function restoreBackup(options, deps) {
	const backupId = backupIdOf(options.prefix);
	const outDir = join(options.cwd, ".restore", backupId);
	mkdirSync(outDir, { recursive: true });
	checkKnownDb(options);
	const databaseId = configDatabaseId(options.config);

	const appliedPath = join(outDir, "applied.json");
	const applied = existsSync(appliedPath)
		? JSON.parse(readFileSync(appliedPath, "utf8"))
		: { database_id: databaseId, files: [] };
	if (applied.files.length > 0 && applied.database_id !== databaseId) {
		throw new Error(
			`restore: ${appliedPath} records files applied to ${applied.database_id}, not ${databaseId}; delete it only if that restore is abandoned`,
		);
	}
	applied.database_id = databaseId;
	const resuming = applied.files.length > 0 || options.from !== null;

	const manifestKey = `${options.prefix}manifest.json`;
	const manifestPath = join(outDir, "manifest.json");
	deps.log(`restore: downloading ${manifestKey}`);
	await deps.r2Get(manifestKey, manifestPath);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.version !== 1) {
		throw new Error(
			`restore: unsupported manifest version ${manifest.version}`,
		);
	}

	if (!options.dryRun) {
		await checkMigrations(manifest, deps);
		if (!resuming) {
			await checkEmpty(manifest, deps);
		}
	}

	await downloadParts(manifest, outDir, deps);
	const { files, orphans } = await generateSql(
		manifest,
		outDir,
		options.maxFileBytes,
	);
	for (const [name, entry] of Object.entries(orphans)) {
		deps.log(`restore: ${name}: ${entry.count} orphaned row(s) skipped`);
	}
	deps.log(
		`restore: wrote ${files.length} SQL file(s) to ${join(outDir, "sql")}`,
	);
	if (options.dryRun) {
		deps.log("restore: --dry-run, nothing applied");
		return { outDir, files, orphans };
	}

	const done = new Map(applied.files.map((f) => [f.name, f.sha256]));
	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const name = basename(file);
		const sha256 = await sha256File(file);
		if (options.from !== null && i + 1 < options.from) {
			continue;
		}
		if (done.has(name)) {
			if (done.get(name) !== sha256) {
				throw new Error(
					`restore: ${name} differs from the file recorded in ${appliedPath}; the SQL was regenerated differently, so resuming is unsafe`,
				);
			}
			continue;
		}
		deps.log(`restore: applying ${name} (${i + 1}/${files.length})`);
		try {
			await deps.execute(file);
		} catch (err) {
			deps.log(
				[
					`restore: stopped at ${name} (${i + 1}/${files.length}); files before it are recorded in ${appliedPath}`,
					"restore: fix the cause and re-run the same command to resume from this file,",
					`restore: or pass --from ${name.replace(/\.sql$/, "")} to start there explicitly`,
				].join("\n"),
			);
			throw err;
		}
		applied.files.push({ name, sha256 });
		writeFileSync(appliedPath, `${JSON.stringify(applied, null, 2)}\n`);
	}
	deps.log("restore: all files applied; run scripts/verify-restore.mjs next");
	return { outDir, files, orphans };
}

export async function verifyChecks({ manifest, orphans, query }) {
	const checks = [];
	function check(name, expected, actual) {
		const exp = JSON.stringify(expected);
		const got = JSON.stringify(actual);
		checks.push({ check: name, expected: exp, actual: got, ok: exp === got });
	}

	for (const table of manifest.tables) {
		check(
			`manifest rows ${table.name}`,
			table.parts.reduce((t, p) => t + p.rows, 0),
			table.rows,
		);
	}

	const integrity = await query("PRAGMA integrity_check");
	check(
		"integrity_check",
		"ok",
		integrity.length === 1 ? Object.values(integrity[0])[0] : integrity,
	);
	check("foreign_key_check", [], await query("PRAGMA foreign_key_check"));

	for (const table of manifest.tables) {
		const name = table.name;
		const rows = await query(`SELECT COUNT(*) AS n FROM ${ident(name)}`);
		check(
			`rows ${name}`,
			table.rows - (orphans[name]?.count ?? 0),
			rows[0]?.n ?? null,
		);
		for (const col of table.columns.filter((c) => c.blob)) {
			const sums = await query(
				`SELECT SUM(LENGTH(${ident(col.name)})) AS s FROM ${ident(name)}`,
			);
			const recorded = table.parts.reduce(
				(t, p) => t + (p.blob_bytes?.[col.name] ?? 0),
				0,
			);
			const dropped = orphans[name]?.blob_bytes?.[col.name] ?? 0;
			check(
				`blob_bytes ${name}.${col.name}`,
				recorded - dropped,
				sums[0]?.s ?? 0,
			);
		}
	}

	const migrations = await query("SELECT name FROM d1_migrations ORDER BY id");
	check(
		"d1_migrations",
		manifest.d1_migrations,
		migrations.map((r) => r.name),
	);
	return checks;
}

export function prepareMigrations(manifest, srcDir, outDir) {
	const missing = manifest.d1_migrations.filter(
		(m) => !existsSync(join(srcDir, m)),
	);
	if (missing.length > 0) {
		throw new Error(
			`restore: migrations listed in the manifest are missing from ${srcDir}: ${missing.join(", ")}; check out a commit that has them`,
		);
	}
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	for (const m of manifest.d1_migrations) {
		copyFileSync(join(srcDir, m), join(outDir, m));
	}
	return [...manifest.d1_migrations];
}
