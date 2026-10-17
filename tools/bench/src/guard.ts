/**
 * Production guard for every bench tool that touches a deployment. The
 * bench only ever targets staging: the seeder refuses a wrangler config that
 * names the production Worker or D1 database, and the runners refuse a URL
 * whose host belongs to production. There is deliberately no override flag.
 *
 * Production is read from `apps/gateway/wrangler.jsonc` (Worker name, D1
 * database names and IDs, `PUBLIC_BASE_URL`, `routes`), plus the
 * `<name>.<account>.workers.dev` host. `HOOKFLARE_PRODUCTION_URL` (comma
 * separated) can only add more hosts to refuse, never remove one.
 */

import { readFileSync } from "node:fs";
import { parseJsonc } from "../../../scripts/lib/jsonc.mjs";

export type ProductionTarget = {
	workerName: string;
	databaseNames: string[];
	databaseIds: string[];
	/** Lowercase hosts that serve production (custom domains, routes). */
	hosts: string[];
};

type WranglerConfig = {
	name: string;
	databaseNames: string[];
	databaseIds: string[];
	raw: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWrangler(text: string): WranglerConfig {
	const raw = parseJsonc(text);
	if (!isRecord(raw))
		throw new Error("guard: wrangler config is not an object");
	if (typeof raw.name !== "string" || raw.name === "") {
		throw new Error("guard: wrangler config has no name");
	}
	const dbs = Array.isArray(raw.d1_databases) ? raw.d1_databases : [];
	const databaseNames: string[] = [];
	const databaseIds: string[] = [];
	for (const db of dbs) {
		if (!isRecord(db)) continue;
		if (typeof db.database_name === "string") {
			databaseNames.push(db.database_name);
		}
		if (typeof db.database_id === "string") databaseIds.push(db.database_id);
	}
	if (databaseNames.length === 0 && databaseIds.length === 0) {
		throw new Error("guard: wrangler config has no d1_databases entry");
	}
	return { name: raw.name, databaseNames, databaseIds, raw };
}

/** Host of a URL or a route pattern such as `api.example.com/*`. */
function hostOf(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed.replace(/\*/g, "x")}`;
	try {
		return new URL(withScheme).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Production identity from the production wrangler config text plus the
 * optional comma-separated `HOOKFLARE_PRODUCTION_URL` value.
 */
export function productionTarget(
	configText: string,
	extraUrls = "",
): ProductionTarget {
	const config = readWrangler(configText);
	const hosts: string[] = [];
	const add = (value: unknown) => {
		if (typeof value !== "string") return;
		const host = hostOf(value);
		if (host && !hosts.includes(host)) hosts.push(host);
	};
	const vars = isRecord(config.raw.vars) ? config.raw.vars : {};
	add(vars.PUBLIC_BASE_URL);
	const routes = Array.isArray(config.raw.routes) ? config.raw.routes : [];
	if (typeof config.raw.route === "string") routes.push(config.raw.route);
	for (const route of routes) {
		add(isRecord(route) ? route.pattern : route);
	}
	for (const url of extraUrls.split(",")) add(url);
	return {
		workerName: config.name,
		databaseNames: config.databaseNames,
		databaseIds: config.databaseIds,
		hosts,
	};
}

/** Reads `apps/gateway/wrangler.jsonc` relative to this file. */
export function loadProductionTarget(
	env: Record<string, string | undefined> = process.env,
): ProductionTarget {
	const text = readFileSync(
		new URL("../../../apps/gateway/wrangler.jsonc", import.meta.url),
		"utf8",
	);
	return productionTarget(text, env.HOOKFLARE_PRODUCTION_URL ?? "");
}

/** Throws when a wrangler config targets the production Worker or D1. */
export function assertNotProductionConfig(
	configText: string,
	prod: ProductionTarget,
): void {
	const config = readWrangler(configText);
	if (config.name === prod.workerName) {
		throw new Error(
			`guard: refusing the production Worker "${config.name}"; the bench only targets staging`,
		);
	}
	for (const name of config.databaseNames) {
		if (prod.databaseNames.includes(name)) {
			throw new Error(
				`guard: refusing the production D1 database "${name}"; the bench only targets staging`,
			);
		}
	}
	for (const id of config.databaseIds) {
		if (prod.databaseIds.includes(id)) {
			throw new Error(
				"guard: refusing the production D1 database_id; the bench only targets staging",
			);
		}
	}
}

/** Throws when `url` is served by production (or does not parse). */
export function assertNotProductionUrl(
	url: string,
	prod: ProductionTarget,
): void {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		throw new Error("guard: target URL does not parse");
	}
	const workersDev = new RegExp(
		`^${prod.workerName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[^.]+\\.workers\\.dev$`,
	);
	if (prod.hosts.includes(host) || workersDev.test(host)) {
		throw new Error(
			`guard: refusing ${host}, which serves production; the bench only targets staging`,
		);
	}
}
