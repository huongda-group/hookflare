import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	deployPlan,
	parseBookmark,
	parseCurrentVersion,
	rollbackCommands,
} from "../lib/deploy.mjs";

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
	clientId: "id",
	clientSecret: "secret",
	sinkUrl: "https://sink.example.com",
};

describe("deployPlan", () => {
	it("runs every step in order when the smoke env is present", () => {
		assert.deepEqual(deployPlan({ smoke, skipSmoke: false }), [
			"record",
			"build",
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

	it("omits smoke only with --skip-smoke", () => {
		const steps = ["record", "build", "migrate", "deploy", "report"];
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
};
const workerRollback = `wrangler rollback 11111111-2222-4333-8444-555555555555 --config ${config}`;
const d1Restore = `wrangler d1 time-travel restore hookflare-staging-db --bookmark=018f2c4a-7b3d-4e5f-9a6b-2c1d3e4f5a6b --config ${config}`;

describe("rollbackCommands", () => {
	it("rolls back to the previous version, never the new one", () => {
		assert.deepEqual(rollbackCommands(record, config), [
			workerRollback,
			d1Restore,
		]);
	});

	it("only lists what the started steps changed", () => {
		assert.deepEqual(rollbackCommands(record, config, ["record", "build"]), []);
		assert.deepEqual(
			rollbackCommands(record, config, ["record", "build", "migrate"]),
			[d1Restore],
		);
		assert.deepEqual(
			rollbackCommands(record, config, [
				"record",
				"build",
				"migrate",
				"deploy",
			]),
			[workerRollback, d1Restore],
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
			`wrangler d1 time-travel restore hookflare-staging --bookmark=018f2c4a-7b3d-4e5f-9a6b-2c1d3e4f5a6b --config ${config}`,
		]);
	});
});
