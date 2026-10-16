import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../lib/jsonc.mjs";

/** @type {string[]} */
export const PARITY_IGNORED_KEYS = [
	"name",
	"database_name",
	"database_id",
	"queue",
	"dead_letter_queue",
	"bucket_name",
	"vars",
	"routes",
	"preview_database_id",
];

const dir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"apps",
	"gateway",
);

/**
 * @returns {{ prod: unknown, staging: unknown }}
 */
function loadConfigs() {
	const prod = parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8"));
	const staging = parseJsonc(
		readFileSync(join(dir, "wrangler.staging.jsonc"), "utf8"),
	);
	return { prod, staging };
}

/**
 * @param {unknown} value
 * @param {Set<string>} keys
 * @returns {unknown}
 */
function stripIgnoredKeys(value, keys) {
	if (Array.isArray(value)) {
		return value.map((item) => stripIgnoredKeys(item, keys));
	}
	if (value !== null && typeof value === "object") {
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (!keys.has(k)) {
				out[k] = stripIgnoredKeys(v, keys);
			}
		}
		return out;
	}
	return value;
}

describe("config parity", () => {
	it("staging matches prod except the ignored keys", () => {
		const { prod, staging } = loadConfigs();
		const ignored = new Set(PARITY_IGNORED_KEYS);
		assert.deepStrictEqual(
			stripIgnoredKeys(staging, ignored),
			stripIgnoredKeys(prod, ignored),
		);
	});

	it("both configs enable global_fetch_strictly_public", () => {
		const { prod, staging } = loadConfigs();
		for (const config of [prod, staging]) {
			assert.ok(
				typeof config === "object" &&
					config !== null &&
					"compatibility_flags" in config,
			);
			const flags = /** @type {{ compatibility_flags: unknown }} */ (config)
				.compatibility_flags;
			assert.ok(Array.isArray(flags));
			assert.ok(flags.includes("global_fetch_strictly_public"));
		}
	});

	it("every staging resource name ends with -staging", () => {
		const { staging } = loadConfigs();
		assert.ok(staging !== null && typeof staging === "object");
		const config = /** @type {Record<string, any>} */ (staging);
		/** @type {string[]} */
		const names = [config.name];
		for (const db of config.d1_databases ?? []) {
			names.push(db.database_name);
		}
		const queues = config.queues ?? {};
		for (const p of queues.producers ?? []) {
			names.push(p.queue);
		}
		for (const c of queues.consumers ?? []) {
			names.push(c.queue);
			if (typeof c.dead_letter_queue === "string") {
				names.push(c.dead_letter_queue);
			}
		}
		for (const b of config.r2_buckets ?? []) {
			names.push(b.bucket_name);
		}
		for (const w of config.workflows ?? []) {
			names.push(w.name);
		}
		assert.ok(names.length > 0);
		for (const n of names) {
			assert.ok(
				typeof n === "string" &&
					(n === "hookflare-staging" || n.endsWith("-staging")),
				`expected staging name, got ${n}`,
			);
		}
	});
});
