import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	deployPlan,
	migrationsApplied,
	parseBookmark,
	parseCurrentVersion,
	rollbackCommands,
} from "../lib/deploy.mjs";
import { smokeEnv } from "../lib/smoke.mjs";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * Read a JSON fixture by name.
 * @param {string} name
 * @returns {unknown}
 */
function fixture(name) {
	return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

describe("parseBookmark", () => {
	it("returns a non-empty string from the time-travel info fixture", () => {
		const bookmark = parseBookmark(fixture("time-travel-info.json"));
		assert.equal(typeof bookmark, "string");
		assert.ok(bookmark.length > 0);
	});
});

describe("parseCurrentVersion", () => {
	it("returns the version ID of the newest deployment", () => {
		assert.equal(
			parseCurrentVersion(fixture("deployments-list.json")),
			"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		);
	});

	it("fails when the newest deployment is a gradual split", () => {
		const list = [
			{
				created_on: "2026-10-10T08:12:00.000Z",
				versions: [{ version_id: "old", percentage: 100 }],
			},
			{
				created_on: "2026-10-12T14:30:00.000Z",
				versions: [
					{ version_id: "a", percentage: 90 },
					{ version_id: "b", percentage: 10 },
				],
			},
		];
		assert.throws(
			() => parseCurrentVersion(list),
			/deploy: the newest deployment splits traffic \(a 90%, b 10%\)/,
		);
	});

	it("accepts a single version without a percentage", () => {
		assert.equal(
			parseCurrentVersion([
				{ created_on: "2026-10-12T14:30:00.000Z", versions: [{ id: "v1" }] },
			]),
			"v1",
		);
	});
});

const smoke = {
	url: "https://hooks.example.com",
	token: "hf_test_token",
	sinkUrl: "https://sink.example.com",
};

describe("deployPlan", () => {
	it("runs every step in order when the smoke env is present", () => {
		assert.deepEqual(deployPlan({ smoke, skipSmoke: false }), [
			"build",
			"record",
			"migrate",
			"deploy",
			"smoke",
			"report",
		]);
	});

	it("fails when the smoke env is missing and --skip-smoke is not set", () => {
		assert.throws(
			() => deployPlan({ smoke: null, skipSmoke: false }),
			/deploy: smoke env missing/,
		);
	});

	it("fails without --skip-smoke when HOOKFLARE_API_TOKEN is missing", () => {
		const env = smokeEnv(
			{
				HOOKFLARE_URL: "https://hooks.example.com",
				SINK_URL: "https://sink.example.com",
			},
			{ urlVar: "HOOKFLARE_URL" },
		);
		assert.equal(env, null);
		assert.throws(
			() => deployPlan({ smoke: env, skipSmoke: false }),
			/deploy: smoke env missing/,
		);
	});

	it("omits smoke only with --skip-smoke", () => {
		const steps = ["build", "record", "migrate", "deploy", "report"];
		assert.deepEqual(deployPlan({ smoke: null, skipSmoke: true }), steps);
		assert.deepEqual(deployPlan({ smoke, skipSmoke: true }), steps);
	});
});

const config = "apps/gateway/wrangler.staging.jsonc";
const record = {
	at: "2026-10-16T00-00-00-000Z",
	config,
	worker: "hookflare-staging",
	d1Name: "hookflare-staging-db",
	previousVersion: "11111111-2222-4333-8444-555555555555",
	newVersion: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
	bookmark: "018f2c4a-7b3d-4e5f-9a6b-2c1d3e4f5a6b",
	bookmarkAt: "2026-10-16T00:01:00.000Z",
	migrationsApplied: true,
};
const workerRollback = `wrangler rollback 11111111-2222-4333-8444-555555555555 --config ${config}`;
const d1Warning =
	"# DESTRUCTIVE: discards every D1 write (including accepted webhooks) since 2026-10-16T00:01:00.000Z; only if the new migrations must be undone";
const d1Restore = `wrangler d1 time-travel restore hookflare-staging-db --bookmark=018f2c4a-7b3d-4e5f-9a6b-2c1d3e4f5a6b --config ${config}`;

describe("rollbackCommands", () => {
	it("rolls back to the previous version, never the new one", () => {
		assert.deepEqual(rollbackCommands(record, config), [
			workerRollback,
			d1Warning,
			d1Restore,
		]);
	});

	it("only lists what the started steps changed", () => {
		assert.deepEqual(rollbackCommands(record, config, ["build", "record"]), []);
		assert.deepEqual(
			rollbackCommands(record, config, ["build", "record", "migrate"]),
			[d1Warning, d1Restore],
		);
		assert.deepEqual(
			rollbackCommands(record, config, [
				"build",
				"record",
				"migrate",
				"deploy",
			]),
			[workerRollback, d1Warning, d1Restore],
		);
	});

	it("omits the D1 restore when the migrate step applied nothing", () => {
		const unchanged = { ...record, migrationsApplied: false };
		assert.deepEqual(rollbackCommands(unchanged, config), [workerRollback]);
		assert.deepEqual(
			rollbackCommands(unchanged, config, ["build", "record", "migrate"]),
			[],
		);
	});

	it("reads records written before previousVersion and d1Name existed", () => {
		const legacy = {
			at: record.at,
			config,
			worker: "hookflare-staging",
			version: "11111111-2222-4333-8444-555555555555",
			bookmark: record.bookmark,
		};
		assert.deepEqual(rollbackCommands(legacy, config), [
			workerRollback,
			"# DESTRUCTIVE: discards every D1 write (including accepted webhooks) since the restore point; only if the new migrations must be undone",
			`wrangler d1 time-travel restore hookflare-staging --bookmark=018f2c4a-7b3d-4e5f-9a6b-2c1d3e4f5a6b --config ${config}`,
		]);
	});
});

describe("migrationsApplied", () => {
	it("is false when wrangler reports nothing to apply", () => {
		assert.equal(
			migrationsApplied({
				code: 0,
				stdout: "\u2705 No migrations to apply!\n",
				stderr: "",
			}),
			false,
		);
		assert.equal(
			migrationsApplied({
				code: 0,
				stdout: "",
				stderr: "No migrations to apply!",
			}),
			false,
		);
	});

	it("is true when wrangler lists migrations to apply", () => {
		assert.equal(
			migrationsApplied({
				code: 0,
				stdout:
					"Migrations to be applied:\n\u250c\u2500\n\u2502 0001_x.sql \u2502\n\u2502 0001_x.sql \u2502 \u2705 \u2502\n",
				stderr: "",
			}),
			true,
		);
	});

	it("is true for unrecognized output or a failed run", () => {
		assert.equal(migrationsApplied({ code: 0, stdout: "", stderr: "" }), true);
		assert.equal(
			migrationsApplied({
				code: 1,
				stdout: "No migrations to apply!",
				stderr: "",
			}),
			true,
		);
	});
});

describe("parseBookmark edge cases", () => {
	it("resolves an array to the newest entry by any supported timestamp key", () => {
		assert.equal(
			parseBookmark([
				{ created_on: "2026-10-01T00:00:00Z", bookmark: "old" },
				{ created_at: "2026-10-03T00:00:00Z", bookmark: "newest" },
				{ timestamp: "2026-10-02T00:00:00Z", bookmark: "middle" },
			]),
			"newest",
		);
	});

	it("skips newer entries without a usable bookmark", () => {
		assert.equal(
			parseBookmark([
				{ created_on: "2026-10-01T00:00:00Z", bookmark: "fallback" },
				{ created_on: "2026-10-05T00:00:00Z", bookmark: "" },
				{ created_on: "2026-10-04T00:00:00Z" },
				null,
				"not-an-entry",
			]),
			"fallback",
		);
	});

	it("throws when no bookmark can be found", () => {
		for (const json of [null, "bookmark", {}, { bookmark: 7 }, [], [{}]]) {
			assert.throws(
				() => parseBookmark(json),
				/deploy: no bookmark in time-travel info output/,
			);
		}
	});
});

describe("parseCurrentVersion edge cases", () => {
	it("accepts an object with a deployments array", () => {
		assert.equal(
			parseCurrentVersion({
				deployments: [
					{
						created_on: "2026-10-01T00:00:00Z",
						versions: [{ version: "v-old", percentage: 100 }],
					},
					{
						created_on: "2026-10-02T00:00:00Z",
						versions: [
							{ version_id: "v-new", percentage: 100 },
							{ version_id: "v-zero", percentage: 0 },
						],
					},
				],
			}),
			"v-new",
		);
	});

	it("throws when the output has no deployments list", () => {
		for (const json of [null, "deployments", 42, {}, { deployments: {} }]) {
			assert.throws(
				() => parseCurrentVersion(json),
				/deploy: no deployments in deployments list output/,
			);
		}
	});

	it("falls back to older deployments when newer ones carry no version", () => {
		assert.equal(
			parseCurrentVersion([
				{
					created_on: "2026-10-01T00:00:00Z",
					versions: [{ version_id: "v-live" }],
				},
				{ created_on: "2026-10-05T00:00:00Z", versions: [] },
				{ created_on: "2026-10-04T00:00:00Z" },
				{ created_on: "2026-10-03T00:00:00Z", versions: [{ id: "" }] },
				null,
			]),
			"v-live",
		);
	});

	it("throws when no deployment has a version", () => {
		assert.throws(
			() => parseCurrentVersion([{ versions: [] }, {}, null, "x"]),
			/deploy: no version in deployments list output/,
		);
		assert.throws(
			() => parseCurrentVersion([]),
			/deploy: no version in deployments list output/,
		);
	});

	it("names unidentified versions in a split-traffic error", () => {
		assert.throws(
			() =>
				parseCurrentVersion([
					{
						versions: [
							{ percentage: 50 },
							{ version_id: "b", percentage: 50 },
							"junk",
						],
					},
				]),
			/splits traffic \(null 50%, b 50%\)/,
		);
	});
});

describe("rollbackCommands without a previous version", () => {
	it("lists only the D1 restore when no rollback target was recorded", () => {
		assert.deepEqual(
			rollbackCommands(
				{
					at: record.at,
					config,
					worker: "hookflare-staging",
					bookmark: "bm",
				},
				config,
			),
			[
				"# DESTRUCTIVE: discards every D1 write (including accepted webhooks) since the restore point; only if the new migrations must be undone",
				`wrangler d1 time-travel restore hookflare-staging --bookmark=bm --config ${config}`,
			],
		);
	});
});
