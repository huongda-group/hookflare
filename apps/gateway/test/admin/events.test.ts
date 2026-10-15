import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { createLogger } from "../../src/core/log";
import { clearSsrfCache } from "../../src/core/ssrf";
import { processDelivery } from "../../src/delivery/consumer";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

describe("admin events", () => {
	beforeEach(() => {
		clearAccessKeyCache();
		clearSsrfCache();
		for (const m of ["log", "warn", "error"] as const)
			vi.spyOn(console, m).mockImplementation(() => {});
	});

	it("returns the event with deliveries and attempts, without the body", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId, deliveryId } = await seedDelivery(deps, p, {
			headers: {
				"content-type": "application/json",
				authorization: "[REDACTED]",
			},
		});
		await processDelivery(deps, deliveryId, createLogger(deps.env, {}));

		const api = await adminApp(deps);
		const res = await api.request("GET", `/events/${eventId}`);
		expect(res.status).toBe(200);
		const event = await res.json<
			Record<string, unknown> & {
				deliveries: { status: string; attempts: { http_status: number }[] }[];
			}
		>();
		expect(event).toMatchObject({
			id: eventId,
			source_id: p.source.id,
			headers: { authorization: "[REDACTED]" },
		});
		expect(event.deliveries).toHaveLength(1);
		expect(event.deliveries[0]).toMatchObject({
			id: deliveryId,
			status: "delivered",
			attempt_count: 1,
		});
		expect(event.deliveries[0].attempts).toEqual([
			expect.objectContaining({ attempt_no: 1, http_status: 200 }),
		]);
		expect(JSON.stringify(event)).not.toContain("hello");
		expect(Object.keys(event)).not.toContain("body_inline");
	});

	it("returns 404 for an unknown event", async () => {
		const api = await adminApp(testDeps());
		expect(
			(await api.request("GET", "/events/evt_01JZZZZZZZZZZZZZZZZZZZZZZZ"))
				.status,
		).toBe(404);
	});
});
