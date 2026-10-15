import type { EventSummary } from "@hookflare/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { createLogger } from "../../src/core/log";
import { clearSsrfCache } from "../../src/core/ssrf";
import { processDelivery } from "../../src/delivery/consumer";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

beforeEach(() => {
	clearAccessKeyCache();
	clearSsrfCache();
	for (const m of ["log", "warn", "error"] as const)
		vi.spyOn(console, m).mockImplementation(() => {});
});

describe("admin events", () => {
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

	it("exposes next_attempt_at on deliveries", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, {
			status: "retrying",
			delivery: { status: "retrying", nextAttemptAt: 123 },
		});
		const api = await adminApp(deps);
		const res = await api.request("GET", `/events/${eventId}`);
		expect(res.status).toBe(200);
		const event = await res.json<{
			deliveries: { next_attempt_at: number | null }[];
		}>();
		expect(event.deliveries).toHaveLength(1);
		expect(event.deliveries[0].next_attempt_at).toBe(123);
	});
});

describe("GET /events", () => {
	async function fixture() {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const base = 1_800_000_000_000 + Math.floor(Math.random() * 1e9);
		const mk = (
			offset: number,
			status: "delivered" | "dead",
			provider?: string,
		) =>
			seedDelivery(deps, p, {
				status,
				event: { receivedAt: base + offset, providerEventId: provider ?? null },
			});
		const a = await mk(0, "delivered", "evt-a");
		const b = await mk(1000, "dead");
		const c = await mk(2000, "delivered");
		const api = await adminApp(deps, { role: "viewer" });
		return { deps, p, base, a, b, c, api };
	}

	it("lists newest first with the latest delivery and pages with a cursor", async () => {
		const { p, a, b, c, api } = await fixture();
		const first = await (
			await api.request("GET", `/events?source_id=${p.source.id}&limit=2`)
		).json<{ data: EventSummary[]; next_cursor: string | null }>();
		expect(first.data.map((e) => e.id)).toEqual([c.eventId, b.eventId]);
		expect(first.data[1].latest_delivery).toMatchObject({
			id: b.deliveryId,
			status: "dead",
		});
		expect(first.next_cursor).not.toBeNull();
		const second = await (
			await api.request(
				"GET",
				`/events?source_id=${p.source.id}&limit=2&cursor=${first.next_cursor}`,
			)
		).json<{ data: EventSummary[]; next_cursor: string | null }>();
		expect(second.data.map((e) => e.id)).toEqual([a.eventId]);
		expect(second.next_cursor).toBeNull();
	});

	it("filters by repeated status, destination, time range, and provider id", async () => {
		const { p, base, a, b, c, api } = await fixture();
		const q = async (qs: string) =>
			(
				await (
					await api.request("GET", `/events?source_id=${p.source.id}&${qs}`)
				).json<{ data: EventSummary[] }>()
			).data.map((e) => e.id);
		expect(await q("status=dead")).toEqual([b.eventId]);
		expect(await q("status=dead&status=delivered")).toEqual([
			c.eventId,
			b.eventId,
			a.eventId,
		]);
		expect(await q(`destination_id=${p.destination.id}&status=dead`)).toEqual([
			b.eventId,
		]);
		expect(await q(`from=${base + 500}&to=${base + 1500}`)).toEqual([
			b.eventId,
		]);
		expect(await q("provider_event_id=evt-a")).toEqual([a.eventId]);
	});

	it("requires source_id with provider_event_id and rejects a bad cursor", async () => {
		const { api } = await fixture();
		expect(
			(await api.request("GET", "/events?provider_event_id=x")).status,
		).toBe(400);
		expect((await api.request("GET", "/events?cursor=garbage")).status).toBe(
			400,
		);
		expect((await api.request("GET", "/events?status=nope")).status).toBe(400);
	});

	it("never returns headers or body in the list", async () => {
		const { p, api } = await fixture();
		const text = await (
			await api.request("GET", `/events?source_id=${p.source.id}`)
		).text();
		expect(text).not.toContain("hello");
		expect(text).not.toContain("headers");
	});
});

describe("GET /events/:id/deliveries", () => {
	it("lists every delivery of the event oldest first", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId, deliveryId } = await seedDelivery(deps, p, {
			status: "dead",
		});
		const api = await adminApp(deps, { role: "viewer" });
		const res = await api.request("GET", `/events/${eventId}/deliveries`);
		expect(res.status).toBe(200);
		const body = await res.json<{ data: { id: string }[] }>();
		expect(body.data.map((d) => d.id)).toEqual([deliveryId]);
		expect(
			(await api.request("GET", "/events/evt_missing/deliveries")).status,
		).toBe(404);
	});
});
