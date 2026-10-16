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
});

describe("deployPlan", () => {
	it("runs every step in order when the smoke env is present", () => {
		assert.deepEqual(
			deployPlan({
				smoke: {
					url: "https://hooks.example.com",
					clientId: "id",
					clientSecret: "secret",
					sinkUrl: "https://sink.example.com",
				},
			}),
			["record", "build", "migrate", "deploy", "smoke", "report"],
		);
	});

	it("omits smoke when the smoke env is missing", () => {
		assert.deepEqual(deployPlan({ smoke: null }), [
			"record",
			"build",
			"migrate",
			"deploy",
			"report",
		]);
	});
});

describe("rollbackCommands", () => {
	it("restores the D1 database named by d1Name", () => {
		const record = {
			at: "2026-10-16T00-00-00-000Z",
			config: "apps/gateway/wrangler.staging.jsonc",
			worker: "hookflare-staging",
			d1Name: "hookflare-staging-db",
			version: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			bookmark: "018f2c4a-7b3d-4e5f-9a6b-2c1d3e4f5a6b",
		};
		assert.deepEqual(
			rollbackCommands(record, "apps/gateway/wrangler.staging.jsonc"),
			[
				"wrangler rollback aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --config apps/gateway/wrangler.staging.jsonc",
				"wrangler d1 time-travel restore hookflare-staging-db --bookmark=018f2c4a-7b3d-4e5f-9a6b-2c1d3e4f5a6b --config apps/gateway/wrangler.staging.jsonc",
			],
		);
	});

	it("falls back to worker for records written before d1Name existed", () => {
		const record = {
			at: "2026-10-16T00-00-00-000Z",
			config: "apps/gateway/wrangler.staging.jsonc",
			worker: "hookflare-staging",
			version: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			bookmark: "018f2c4a-7b3d-4e5f-9a6b-2c1d3e4f5a6b",
		};
		assert.deepEqual(
			rollbackCommands(record, "apps/gateway/wrangler.staging.jsonc"),
			[
				"wrangler rollback aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --config apps/gateway/wrangler.staging.jsonc",
				"wrangler d1 time-travel restore hookflare-staging --bookmark=018f2c4a-7b3d-4e5f-9a6b-2c1d3e4f5a6b --config apps/gateway/wrangler.staging.jsonc",
			],
		);
	});
});
