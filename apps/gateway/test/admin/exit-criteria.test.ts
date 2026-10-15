import { asc, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { createApp } from "../../src/app";
import {
	auditLogs,
	deliveries,
	deliveryAttempts,
} from "../../src/core/db/schema";
import { createLogger } from "../../src/core/log";
import { processDelivery } from "../../src/delivery/consumer";
import { adminApp } from "../helpers/admin";
import { type RecordingQueue, recordingQueue, testDeps } from "../helpers/deps";
import { seedPipeline } from "../helpers/seed";

// Each adminApp mints fresh keys under the same kid.
beforeEach(() => {
	clearAccessKeyCache();
});

describe("M3 exit criteria", () => {
	it("replay preserves history and every replay is audited", async () => {
		let status = 400;
		const fetch = vi.fn(async () => new Response("x", { status }));
		const deps = testDeps({
			fetch: fetch as unknown as typeof globalThis.fetch,
			queue: recordingQueue(),
		});
		const p = await seedPipeline(deps);
		const logger = createLogger(deps.env, {});

		// 1. Ingest one event; the backend answers 400 → failed_final.
		const ingress = await createApp({ createDeps: () => deps }).request(
			`/in/${p.source.id}`,
			{
				method: "POST",
				body: '{"n":1}',
				headers: { "content-type": "application/json" },
			},
			deps.env,
		);
		expect(ingress.status).toBe(202);
		const queue = deps.queue as RecordingQueue;
		const [{ deliveryId }] = queue.sent;
		await processDelivery(deps, deliveryId, logger);

		const snapshot = async () => ({
			delivery: await deps.db
				.select()
				.from(deliveries)
				.where(eq(deliveries.id, deliveryId)),
			attempts: await deps.db
				.select()
				.from(deliveryAttempts)
				.where(eq(deliveryAttempts.deliveryId, deliveryId))
				.orderBy(asc(deliveryAttempts.id)),
		});
		const before = await snapshot();
		expect(before.delivery[0].status).toBe("failed_final");

		// 2. Fix the backend, replay single and bulk.
		status = 200;
		const op = await adminApp(deps, { role: "operator" });
		const single = await (
			await op.request("POST", `/events/${before.delivery[0].eventId}/replay`, {
				reason: "fixed",
			})
		).json<{ delivery_id: string }>();
		await processDelivery(deps, single.delivery_id, logger);
		const bulk = await (
			await op.request("POST", "/failures/replay", {
				delivery_ids: [deliveryId],
				reason: "again",
			})
		).json<{ replayed: { new_delivery_id: string }[] }>();
		expect(bulk.replayed).toHaveLength(1);

		// 3. The original delivery and its attempts are byte-for-byte unchanged.
		expect(await snapshot()).toEqual(before);

		// 4. Every replay delivery is named in exactly one delivery.replayed audit row.
		const replays = await deps.db
			.select({ id: deliveries.id })
			.from(deliveries)
			.where(eq(deliveries.kind, "replay"));
		const audits = await deps.db
			.select()
			.from(auditLogs)
			.where(inArray(auditLogs.action, ["delivery.replayed"]));
		const audited = audits.flatMap((a) =>
			((a.diffJson?.replayed ?? []) as { new_delivery_id: string }[]).map(
				(r) => r.new_delivery_id,
			),
		);
		expect(audited.sort()).toEqual(replays.map((r) => r.id).sort());
		expect(audits.every((a) => a.actorEmail === op.email && a.reason)).toBe(
			true,
		);
	});
});
