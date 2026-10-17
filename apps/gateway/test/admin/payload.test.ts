import { beforeEach, describe, expect, it } from "vitest";
import { adminApp, auditRows } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";
import { seedDelivery, seedPipeline } from "../helpers/seed";

describe("GET /events/:id/payload", () => {

	it("returns the raw bytes with safe headers and audits the view", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, {
			body: new TextEncoder().encode('{"card":"4242"}'),
		});
		const api = await adminApp(deps, { role: "operator" });
		const res = await api.request("GET", `/events/${eventId}/payload`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('{"card":"4242"}');
		expect(res.headers.get("content-type")).toBe("application/json");
		expect(res.headers.get("content-disposition")).toBe(
			`attachment; filename="${eventId}"`,
		);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const rows = await auditRows(deps, eventId);
		expect(rows.map((r) => [r.action, r.actor])).toEqual([
			["event.payload_viewed", api.username],
		]);
		expect(JSON.stringify(rows)).not.toContain("4242");
	});

	it("defaults the payload content type to octet-stream", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, { contentType: null });
		const api = await adminApp(deps, { role: "operator" });
		const res = await api.request("GET", `/events/${eventId}/payload`);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
	});

	it("forbids a viewer", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p);
		const api = await adminApp(deps, { role: "viewer" });
		const res = await api.request("GET", `/events/${eventId}/payload`);
		expect(res.status).toBe(403);
		expect(await auditRows(deps, eventId)).toEqual([]);
	});

	it("answers 404 payload_missing when the R2 object is gone and 503 on an R2 error", async () => {
		const base = testDeps();
		const p = await seedPipeline(base);
		const { eventId } = await seedDelivery(base, p, {
			body: new Uint8Array(),
			event: { r2Key: "payloads/missing" },
		});
		const api = await adminApp(base, { role: "operator" });
		const missing = await api.request("GET", `/events/${eventId}/payload`);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "payload_missing" });

		const broken = await adminApp(
			faultyDeps(base, { r2: [{ match: /^get / }] }),
			{ username: api.username },
		);
		expect(
			(await broken.request("GET", `/events/${eventId}/payload`)).status,
		).toBe(503);
		expect(await auditRows(base, eventId)).toEqual([]);
	});

	it("does not return the payload when the audit write fails", async () => {
		const base = testDeps();
		const p = await seedPipeline(base);
		const { eventId } = await seedDelivery(base, p);
		const op = await adminApp(base, { role: "operator" });
		const api = await adminApp(
			faultyDeps(base, { d1: [{ match: /insert into "audit_logs"/i }] }),
			{ username: op.username },
		);
		const res = await api.request("GET", `/events/${eventId}/payload`);
		expect(res.status).toBe(503);
		expect(await res.text()).not.toContain("hello");
	});
});
