import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/db/archive";
import { archiveBatches, webhookEvents } from "../../src/core/db/schema";
import { isolateArchive, listKeys } from "../helpers/archive";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

describe("ArchiveWorkflow end to end (spec §7.8)", () => {
	const deps = testDeps();
	beforeEach(() => isolateArchive(deps));

	it("archives, verifies, and purges an old delivered event", async () => {
		const p = await seedPipeline(deps);
		const old = Date.now() - 45 * DAY_MS;
		const { eventId } = await seedDelivery(deps, p, {
			status: "delivered",
			event: { receivedAt: old },
		});
		const id = `archive-test-${Date.now()}`;
		const instance = await introspectWorkflowInstance(env.ARCHIVE, id);
		try {
			await env.ARCHIVE.create({ id, params: { trigger: "manual" } });
			await instance.waitForStatus("complete");
		} finally {
			await instance.dispose();
		}
		expect(
			await deps.db
				.select()
				.from(webhookEvents)
				.where(eq(webhookEvents.id, eventId)),
		).toEqual([]);
		const [batch] = await deps.db
			.select()
			.from(archiveBatches)
			.where(eq(archiveBatches.workflowInstanceId, id));
		expect(batch.status).toBe("purged");
		const day = new Date(old).toISOString().slice(0, 10).replaceAll("-", "/");
		expect(
			await listKeys(deps.payloads, `archive/${day}/${batch.id}/`),
		).toEqual([
			`archive/${day}/${batch.id}/manifest.json`,
			`archive/${day}/${batch.id}/part-0001.ndjson.gz`,
		]);
	});
});
