import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { readConfig, runWrangler } from "../lib/wrangler.mjs";

function withFakePnpm() {
	const dir = mkdtempSync(join(tmpdir(), "fake-pnpm-"));
	const bin = join(dir, "pnpm");
	writeFileSync(
		bin,
		[
			"#!/bin/sh",
			'echo "args:$*"',
			'echo "warn:$FAKE_ERR" 1>&2',
			'if [ -n "$FAKE_SIGNAL" ]; then kill -9 $$; fi',
			'exit "${FAKE_CODE:-0}"',
			"",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	return dir;
}

describe("runWrangler", () => {
	const saved = { ...process.env };
	beforeEach(() => {
		process.env.PATH = `${withFakePnpm()}:${saved.PATH}`;
	});
	afterEach(() => {
		process.env = { ...saved };
		mock.restoreAll();
	});

	it("runs the repo wrangler through pnpm exec with --config and captures output", async () => {
		process.env.FAKE_ERR = "careful";
		const res = await runWrangler(["d1", "list"], { config: "w.jsonc" });
		assert.equal(res.code, 0);
		assert.equal(res.stdout, "args:exec wrangler d1 list --config w.jsonc\n");
		assert.equal(res.stderr, "warn:careful\n");
	});

	it("returns a non-zero exit code instead of throwing", async () => {
		process.env.FAKE_CODE = "3";
		const res = await runWrangler(["deploy"], { config: "w.jsonc" });
		assert.equal(res.code, 3);
	});

	it("reports exit code 1 when the process is killed by a signal", async () => {
		process.env.FAKE_SIGNAL = "1";
		const res = await runWrangler(["deploy"], { config: "w.jsonc" });
		assert.equal(res.code, 1);
	});

	it("echoes output as it arrives with stream, and still captures it", async () => {
		const out = mock.method(process.stdout, "write", () => true);
		const err = mock.method(process.stderr, "write", () => true);
		const res = await runWrangler(["deploy"], {
			config: "w.jsonc",
			stream: true,
		});
		const echoed = (m) => m.mock.calls.map((c) => String(c.arguments[0]));
		assert.ok(echoed(out).includes(res.stdout));
		assert.ok(echoed(err).includes(res.stderr));
	});

	it("rejects when pnpm cannot be spawned", async () => {
		process.env.PATH = mkdtempSync(join(tmpdir(), "empty-path-"));
		await assert.rejects(runWrangler(["deploy"], { config: "w.jsonc" }), {
			code: "ENOENT",
		});
	});
});

describe("readConfig", () => {
	const write = (text) => {
		const path = join(mkdtempSync(join(tmpdir(), "wcfg-")), "wrangler.jsonc");
		writeFileSync(path, text);
		return path;
	};

	it("reads the name, first D1 database, and PUBLIC_BASE_URL from JSONC", () => {
		const path = write(`{
			// comment
			"name": "hookflare",
			"d1_databases": [{ "database_name": "hookflare-db" }, { "database_name": "x" }],
			"vars": { "PUBLIC_BASE_URL": "https://hooks.example.com" },
		}`);
		assert.deepEqual(readConfig(path), {
			name: "hookflare",
			d1Name: "hookflare-db",
			publicBaseUrl: "https://hooks.example.com",
		});
	});

	it("defaults publicBaseUrl to an empty string when unset or not a string", () => {
		const base = '"name": "w", "d1_databases": [{ "database_name": "d" }]';
		assert.equal(readConfig(write(`{ ${base} }`)).publicBaseUrl, "");
		assert.equal(
			readConfig(write(`{ ${base}, "vars": { "PUBLIC_BASE_URL": 1 } }`))
				.publicBaseUrl,
			"",
		);
	});

	it("throws when the Worker name is missing or empty", () => {
		for (const name of ["", undefined]) {
			const path = write(
				JSON.stringify({ name, d1_databases: [{ database_name: "d" }] }),
			);
			assert.throws(() => readConfig(path), /has no name/);
		}
	});

	it("throws when there is no D1 database", () => {
		for (const dbs of [undefined, [], [{ database_name: "" }], "nope"]) {
			const path = write(JSON.stringify({ name: "w", d1_databases: dbs }));
			assert.throws(() => readConfig(path), /has no d1_databases entry/);
		}
	});
});
