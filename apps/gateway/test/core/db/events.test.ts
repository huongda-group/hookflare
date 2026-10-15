import { describe, expect, it } from "vitest";
import {
	findEventIdByProviderId,
	insertEventWithDelivery,
} from "../../../src/core/db/events";
import { newId } from "../../../src/core/ids";
import { testDeps } from "../../helpers/deps";
import { seedDelivery, seedPipeline } from "../../helpers/seed";

describe("events dedup", () => {
	it("finds an event by (source, provider event id)", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const { eventId } = await seedDelivery(deps, p, {
			event: { providerEventId: "abc" },
		});
		expect(await findEventIdByProviderId(deps.db, p.source.id, "abc")).toBe(
			eventId,
		);
		expect(
			await findEventIdByProviderId(deps.db, p.source.id, "zzz"),
		).toBeNull();
	});

	it("rolls back the whole batch when the provider event id already exists", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p, { event: { providerEventId: "abc" } });
		const now = deps.now();
		const eventId = newId("evt", now);
		await expect(
			insertEventWithDelivery(deps, {
				event: {
					id: eventId,
					projectId: p.project.id,
					sourceId: p.source.id,
					providerEventId: "abc",
					receivedAt: now,
					headersJson: {},
					contentType: null,
					sizeBytes: 0,
					payloadSha256: "0".repeat(64),
					bodyInline: new Uint8Array(),
				},
				delivery: {
					id: newId("dlv", now),
					eventId,
					destinationId: p.destination.id,
					projectId: p.project.id,
					kind: "initial",
					status: "pending",
					attemptCount: 0,
					createdAt: now,
				},
			}),
		).rejects.toThrow(/FOREIGN KEY/);
	});
});
