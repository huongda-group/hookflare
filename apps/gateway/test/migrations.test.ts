import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deliveries, webhookEvents } from "../src/core/db/schema";
import { testDeps } from "./helpers/deps";
import { seedDelivery, seedPipeline } from "./helpers/seed";

function migration(prefix: string) {
	const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith(prefix));
	if (!m) throw new Error(`migration ${prefix} not found`);
	return m;
}

const UNIQUE_INDEX = "webhook_events_source_provider_uq";

describe("0003 + 0004", () => {
	it("collapses M1 duplicates so the unique index can be built", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const createIndex = migration("0004").queries.find((q) =>
			q.includes(UNIQUE_INDEX),
		);
		if (!createIndex) throw new Error("0004 has no unique index");
		// Recreate the M1 state: no unique index, duplicates present.
		await env.DB.prepare(`DROP INDEX ${UNIQUE_INDEX}`).run();
		try {
			const first = await seedDelivery(deps, p, {
				event: { providerEventId: "dup" },
			});
			const second = await seedDelivery(deps, p, {
				event: { providerEventId: "dup" },
			});
			const other = await seedDelivery(deps, p, {
				event: { providerEventId: "unique" },
			});

			await env.DB.batch(
				migration("0003").queries.map((q) => env.DB.prepare(q)),
			);
			await env.DB.prepare(createIndex).run();

			const ids = async (eventId: string) =>
				(
					await deps.db
						.select({ pid: webhookEvents.providerEventId })
						.from(webhookEvents)
						.where(eq(webhookEvents.id, eventId))
				)[0].pid;
			expect(await ids(first.eventId)).toBe("dup");
			expect(await ids(second.eventId)).toBeNull();
			expect(await ids(other.eventId)).toBe("unique");
			expect(
				await deps.db.$count(
					deliveries,
					eq(deliveries.projectId, p.project.id),
				),
			).toBe(3);
			// Drizzle wraps the D1 error: UNIQUE is in cause.message.
			const dupErr = await seedDelivery(deps, p, {
				event: { providerEventId: "dup" },
			}).then(
				() => null,
				(e) => e as Error,
			);
			expect(dupErr).not.toBeNull();
			expect(String(dupErr?.cause ?? dupErr)).toMatch(/UNIQUE/);
		} finally {
			await env.DB.prepare(
				createIndex.replace(
					"CREATE UNIQUE INDEX",
					"CREATE UNIQUE INDEX IF NOT EXISTS",
				),
			).run();
		}
	});

	it("allows many events without a provider event id", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		await seedDelivery(deps, p);
		await expect(seedDelivery(deps, p)).resolves.toBeDefined();
	});
});
