import type { Alert, AlertDetail, Page } from "@hookflare/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { alerts } from "../../src/core/db/schema";
import { adminApp } from "../helpers/admin";
import { resetAlerts } from "../helpers/alerts";
import { testDeps } from "../helpers/deps";
import { seedPipeline } from "../helpers/seed";

describe("alerts API", () => {
	const deps = testDeps();
	beforeEach(async () => {
		await resetAlerts(deps);
	});

	it("lists newest first with filters and returns detail with notifications", async () => {
		const p = await seedPipeline(deps);
		await deps.db.insert(alerts).values([
			{
				id: "alr_01",
				rule: "new_dead",
				resourceType: "destination",
				resourceId: p.destination.id,
				projectId: p.project.id,
				status: "resolved",
				openedAt: 1,
				resolvedAt: 2,
				detailsJson: "{}",
			},
			{
				id: "alr_02",
				rule: "stuck_pending",
				resourceType: "destination",
				resourceId: p.destination.id,
				projectId: p.project.id,
				status: "open",
				openedAt: 3,
				detailsJson: '{"stuck":4}',
			},
		]);
		const app = await adminApp(deps, { role: "viewer" });
		const all = await (await app.request("GET", "/alerts")).json<Page<Alert>>();
		expect(all.data.map((a: { id: string }) => a.id)).toEqual([
			"alr_02",
			"alr_01",
		]);
		expect(all.data[0]).toMatchObject({
			resource_name: p.destination.name,
			details: { stuck: 4 },
		});
		const open = await (await app.request("GET", "/alerts?status=open")).json<
			Page<Alert>
		>();
		expect(open.data.map((a: { id: string }) => a.id)).toEqual(["alr_02"]);
		const detail = await (
			await app.request("GET", "/alerts/alr_02")
		).json<AlertDetail>();
		expect(detail.notifications).toEqual([]);
		expect((await app.request("GET", "/alerts/alr_missing")).status).toBe(404);
	});
});
