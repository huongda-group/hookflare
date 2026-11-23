import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decryptSecret } from "../src/core/crypto";
import { createDeps } from "../src/deps";
import { recordingQueue, testDeps } from "./helpers/deps";
import { testEnv } from "./helpers/env";
import {
	seedDelivery,
	seedPipeline,
	TEST_SIGNING_SECRET,
	TEST_SOURCE_SECRET,
} from "./helpers/seed";

describe("createDeps", () => {
	it("wires the real D1, queue, and rate limiter bindings", async () => {
		const deps = createDeps(testEnv());
		await expect(deps.db.query.projects.findMany()).resolves.toEqual([]);
		expect(typeof deps.queue.send).toBe("function");
		expect(typeof deps.now()).toBe("number");
		expect(
			typeof (env as unknown as { INGRESS_LIMITER: RateLimit }).INGRESS_LIMITER
				.limit,
		).toBe("function");
	});
});

describe("test helpers", () => {
	it("recordingQueue records and can fail", async () => {
		const q = recordingQueue();
		await q.send({ deliveryId: "dlv_x" });
		expect(q.sent).toEqual([{ deliveryId: "dlv_x" }]);
		await expect(
			recordingQueue({ fail: true }).send({ deliveryId: "dlv_y" }),
		).rejects.toThrow();
	});

	it("seedPipeline stores encrypted secrets bound to their row", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps, {
			source: {
				authType: "token",
				authConfig: { in: "header", name: "x-token" },
			},
		});
		expect(p.source.secretEnc).not.toContain(TEST_SOURCE_SECRET);
		await expect(
			decryptSecret(
				deps.env,
				p.source.secretEnc as string,
				`sources.secret_enc:${p.source.id}`,
			),
		).resolves.toBe(TEST_SOURCE_SECRET);
		await expect(
			decryptSecret(
				deps.env,
				p.destination.signingSecretEnc,
				`destinations.signing_secret_enc:${p.destination.id}`,
			),
		).resolves.toBe(TEST_SIGNING_SECRET);
	});

	it("seedDelivery stores an event and a delivery", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId, deliveryId } = await seedDelivery(deps, p, {
			status: "queued",
		});
		const d = await deps.db.query.deliveries.findFirst({
			where: (t, { eq }) => eq(t.id, deliveryId),
		});
		expect(d).toMatchObject({ eventId, status: "queued", attemptCount: 0 });
	});
});
