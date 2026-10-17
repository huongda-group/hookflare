import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../lib/jsonc.mjs";

/**
 * Environment-specific values, as paths: `.` separates keys and `[]` stands
 * for every element of an array. Only resource names, IDs, and
 * per-deployment vars/routes are ignored; binding names (`binding`, a DO
 * binding's or a rate limiter's `name`) are still compared.
 * @type {string[]}
 */
export const PARITY_IGNORED_PATHS = [
	"name",
	"vars",
	"routes",
	"d1_databases[].database_name",
	"d1_databases[].database_id",
	"d1_databases[].preview_database_id",
	"queues.producers[].queue",
	"queues.consumers[].queue",
	"queues.consumers[].dead_letter_queue",
	"r2_buckets[].bucket_name",
	"workflows[].name",
	// Account-unique per Worker: staging must not share production's counters.
	"ratelimits[].namespace_id",
];

const dir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"apps",
	"gateway",
);

/**
 * @returns {{ prod: any, staging: any }}
 */
function loadConfigs() {
	const prod = parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8"));
	const staging = parseJsonc(
		readFileSync(join(dir, "wrangler.staging.jsonc"), "utf8"),
	);
	return { prod, staging };
}

/**
 * Copy of `value` without the ignored paths.
 * @param {unknown} value
 * @param {Set<string>} paths
 * @param {string} [at] Path of `value` itself ("" at the root).
 * @returns {unknown}
 */
export function stripIgnoredPaths(value, paths, at = "") {
	if (Array.isArray(value)) {
		return value.map((item) => stripIgnoredPaths(item, paths, `${at}[]`));
	}
	if (value !== null && typeof value === "object") {
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			const path = at === "" ? k : `${at}.${k}`;
			if (!paths.has(path)) {
				out[k] = stripIgnoredPaths(v, paths, path);
			}
		}
		return out;
	}
	return value;
}

describe("stripIgnoredPaths", () => {
	it("drops resource names but keeps binding names", () => {
		const ignored = new Set(PARITY_IGNORED_PATHS);
		const config = {
			name: "hookflare",
			durable_objects: {
				bindings: [{ name: "LIMITER", class_name: "DestinationLimiter" }],
			},
			ratelimits: [{ name: "INGRESS_LIMITER", namespace_id: "1001" }],
			workflows: [{ name: "hookflare-archive", binding: "ARCHIVE" }],
		};
		assert.deepEqual(stripIgnoredPaths(config, ignored), {
			durable_objects: {
				bindings: [{ name: "LIMITER", class_name: "DestinationLimiter" }],
			},
			ratelimits: [{ name: "INGRESS_LIMITER" }],
			workflows: [{ binding: "ARCHIVE" }],
		});
	});
});

describe("config parity", () => {
	it("staging matches prod except the ignored paths", () => {
		const { prod, staging } = loadConfigs();
		const ignored = new Set(PARITY_IGNORED_PATHS);
		assert.deepStrictEqual(
			stripIgnoredPaths(staging, ignored),
			stripIgnoredPaths(prod, ignored),
		);
	});

	it("staging rate limiters use their own namespace IDs", () => {
		const { prod, staging } = loadConfigs();
		const prodIds = new Set(
			(prod.ratelimits ?? []).map((limiter) => limiter.namespace_id),
		);
		for (const limiter of staging.ratelimits ?? []) {
			assert.ok(
				!prodIds.has(limiter.namespace_id),
				`staging ${limiter.name} reuses production namespace_id ${limiter.namespace_id}`,
			);
		}
	});

	it("both configs enable global_fetch_strictly_public", () => {
		const { prod, staging } = loadConfigs();
		for (const config of [prod, staging]) {
			assert.ok(Array.isArray(config.compatibility_flags));
			assert.ok(
				config.compatibility_flags.includes("global_fetch_strictly_public"),
			);
		}
	});

	it("every staging resource name ends with -staging", () => {
		const { staging: config } = loadConfigs();
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
