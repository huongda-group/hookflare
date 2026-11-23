import { describe, expect, it } from "vitest";
import {
	assertNotProductionConfig,
	assertNotProductionUrl,
	loadProductionTarget,
	productionTarget,
} from "../src/guard";

const PROD = `{
	// production
	"name": "hookflare",
	"vars": { "PUBLIC_BASE_URL": "https://hooks.example.com" },
	"routes": [
		{ "pattern": "api.example.com/*", "zone_name": "example.com" },
		"edge.example.com/in/*",
	],
	"d1_databases": [
		{ "binding": "DB", "database_name": "hookflare", "database_id": "prod-id" },
	],
}`;

function staging(name: string, dbName: string, dbId: string): string {
	return JSON.stringify({
		name,
		d1_databases: [{ binding: "DB", database_name: dbName, database_id: dbId }],
	});
}

const STAGING = staging("hookflare-staging", "hookflare-staging", "stg-id");

describe("productionTarget", () => {
	it("reads name, databases, and every public host", () => {
		const prod = productionTarget(PROD);
		expect(prod.workerName).toBe("hookflare");
		expect(prod.databaseNames).toEqual(["hookflare"]);
		expect(prod.databaseIds).toEqual(["prod-id"]);
		expect(prod.hosts).toEqual([
			"hooks.example.com",
			"api.example.com",
			"edge.example.com",
		]);
	});

	it("loads the real production config", () => {
		const prod = loadProductionTarget({});
		expect(prod.workerName).toBe("hookflare");
		expect(prod.databaseNames).toContain("hookflare");
	});
});

describe("assertNotProductionConfig", () => {
	const prod = productionTarget(PROD);

	it("accepts the staging config", () => {
		expect(() => assertNotProductionConfig(STAGING, prod)).not.toThrow();
	});

	it("refuses the production worker name", () => {
		expect(() =>
			assertNotProductionConfig(
				staging("hookflare", "hookflare-staging", "stg-id"),
				prod,
			),
		).toThrow(/production/);
	});

	it("refuses a config pointing at the production database name or id", () => {
		expect(() =>
			assertNotProductionConfig(
				staging("hookflare-staging", "hookflare", "stg-id"),
				prod,
			),
		).toThrow(/production/);
		expect(() =>
			assertNotProductionConfig(
				staging("hookflare-staging", "hookflare-staging", "prod-id"),
				prod,
			),
		).toThrow(/production/);
	});

	it("refuses the production config itself", () => {
		expect(() => assertNotProductionConfig(PROD, prod)).toThrow(/production/);
	});

	it("refuses a config without a name or database", () => {
		expect(() => assertNotProductionConfig("{}", prod)).toThrow();
	});
});

describe("assertNotProductionUrl", () => {
	const prod = productionTarget(PROD);

	it("accepts a staging workers.dev URL", () => {
		expect(() =>
			assertNotProductionUrl(
				"https://hookflare-staging.acme.workers.dev",
				prod,
			),
		).not.toThrow();
	});

	it("refuses the production workers.dev host", () => {
		expect(() =>
			assertNotProductionUrl("https://hookflare.acme.workers.dev/", prod),
		).toThrow(/production/);
		expect(() =>
			assertNotProductionUrl("https://HOOKFLARE.acme.workers.dev", prod),
		).toThrow(/production/);
	});

	it("refuses PUBLIC_BASE_URL and route hosts", () => {
		for (const url of [
			"https://hooks.example.com",
			"https://api.example.com/x",
			"https://edge.example.com",
		]) {
			expect(() => assertNotProductionUrl(url, prod)).toThrow(/production/);
		}
	});

	it("refuses extra hosts named in HOOKFLARE_PRODUCTION_URL", () => {
		const withExtra = productionTarget(
			PROD,
			"https://prod.internal.example, https://other.example",
		);
		expect(() =>
			assertNotProductionUrl("https://prod.internal.example/in", withExtra),
		).toThrow(/production/);
		expect(() =>
			assertNotProductionUrl("https://other.example", withExtra),
		).toThrow(/production/);
	});

	it("refuses an unparseable URL", () => {
		expect(() => assertNotProductionUrl("not a url", prod)).toThrow();
	});
});
