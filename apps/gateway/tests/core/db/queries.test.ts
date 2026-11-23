import { describe, expect, it } from "vitest";
import { searchAuditLogs } from "../../../src/core/db/audit-logs";
import { listFailures } from "../../../src/core/db/deliveries";
import {
	listDestinations,
	transitionDestination,
} from "../../../src/core/db/destinations";
import { getEventDetail } from "../../../src/core/db/events";
import { auditLogs, webhookEvents } from "../../../src/core/db/schema";
import { listSources } from "../../../src/core/db/sources";
import { newId } from "../../../src/core/ids";
import { testDeps } from "../../helpers/deps";
import { seedDelivery, seedPipeline } from "../../helpers/seed";

const T0 = 1_800_000_000_000;

describe("searchAuditLogs", () => {
	it("keeps only entries inside the inclusive [from, to] window", async () => {
		const deps = testDeps();
		const actor = `audit-window-${crypto.randomUUID()}`;
		const at = [T0 - 2, T0 - 1, T0, T0 + 1, T0 + 2];
		await deps.db.insert(auditLogs).values(
			at.map((t) => ({
				id: newId("aud", t),
				actor,
				action: "test.window",
				resourceType: "test",
				at: t,
			})),
		);
		const rows = await searchAuditLogs(deps.db, {
			actor,
			from: T0 - 1,
			to: T0 + 1,
			limit: 10,
		});
		expect(rows.map((r) => r.at)).toEqual([T0 + 1, T0, T0 - 1]);
	});
});

describe("listFailures", () => {
	it("keeps only failures completed inside the inclusive [from, to] window", async () => {
		const deps = testDeps({ now: () => T0 });
		const p = await seedPipeline(deps);
		const ids: Record<number, string> = {};
		for (const t of [T0 - 1, T0, T0 + 1, T0 + 2]) {
			const { deliveryId } = await seedDelivery(deps, p, {
				status: "dead",
				delivery: { completedAt: t },
			});
			ids[t] = deliveryId;
		}
		const rows = await listFailures(deps.db, {
			destinationId: p.destination.id,
			from: T0,
			to: T0 + 1,
			unresolved: false,
			limit: 10,
		});
		expect(rows.map((r) => r.id)).toEqual([ids[T0 + 1], ids[T0]]);
	});
});

describe("listDestinations / listSources cursor paging", () => {
	it("returns only rows older than the cursor, newest first", async () => {
		const deps = testDeps();
		const a = await seedPipeline(deps);
		const b = await seedPipeline(deps);
		const firstPage = await listDestinations(deps.db, { limit: 50 });
		expect(firstPage.map((d) => d.id)).toContain(b.destination.id);
		const after = await listDestinations(deps.db, {
			limit: 50,
			cursor: b.destination.id,
		});
		expect(after.map((d) => d.id)).not.toContain(b.destination.id);
		expect(after.map((d) => d.id)).toContain(a.destination.id);
		expect(after.every((d) => d.id < b.destination.id)).toBe(true);

		const sourcesAfter = await listSources(deps.db, {
			limit: 50,
			cursor: b.source.id,
		});
		expect(sourcesAfter.map((s) => s.id)).not.toContain(b.source.id);
		expect(sourcesAfter.map((s) => s.id)).toContain(a.source.id);
		expect(sourcesAfter.every((s) => s.id < b.source.id)).toBe(true);
	});
});

describe("transitionDestination", () => {
	it("changes status only when the row is in the expected state", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps);
		const paused = await transitionDestination(
			deps.db,
			p.destination.id,
			"active",
			"paused",
			T0,
		);
		expect(paused).toMatchObject({ status: "paused", updatedAt: T0 });
		// Already paused: a second active→paused is a no-op.
		expect(
			await transitionDestination(
				deps.db,
				p.destination.id,
				"active",
				"paused",
				T0 + 1,
			),
		).toBeUndefined();
	});
});

describe("getEventDetail", () => {
	it("returns an event with no deliveries without querying attempts", async () => {
		const deps = testDeps({ now: () => T0 });
		const p = await seedPipeline(deps);
		const id = newId("evt", T0);
		await deps.db.insert(webhookEvents).values({
			id,
			projectId: p.project.id,
			sourceId: p.source.id,
			receivedAt: T0,
			headersJson: {},
			contentType: null,
			sizeBytes: 0,
			payloadSha256: "0".repeat(64),
			bodyInline: new Uint8Array(),
		});
		const detail = await getEventDetail(deps.db, id);
		expect(detail?.event.id).toBe(id);
		expect(detail?.deliveries).toEqual([]);
	});
});
