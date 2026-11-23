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

	it("separates project and deployment incident lists and details", async () => {
		const a = await seedPipeline(deps);
		const b = await seedPipeline(deps);
		const projectScope = `project_id=${a.project.id}`;
		const incident = (
			id: string,
			projectId: string | null,
		): typeof alerts.$inferInsert => ({
			id,
			projectId,
			rule: projectId ? "new_dead" : "d1_storage",
			resourceType: projectId ? "destination" : "system",
			resourceId: id,
			status: "open",
			openedAt: 1,
			detailsJson: "{}",
		});
		await deps.db
			.insert(alerts)
			.values([
				incident("alr_a", a.project.id),
				incident("alr_b", b.project.id),
				incident("alr_sys", null),
			]);
		const api = await adminApp(deps, { role: "viewer" });
		for (const [scope, expected] of [
			[projectScope, "alr_a"],
			["scope=deployment", "alr_sys"],
		]) {
			const res = await api.request("GET", `/alerts?${scope}&limit=1`);
			const page = await res.json<Page<Alert>>();
			expect.soft(res.status, JSON.stringify(page)).toBe(200);
			expect.soft(page.data?.map((a) => a.id)).toEqual([expected]);
			expect.soft(page.next_cursor).toBeNull();
			expect
				.soft((await api.request("GET", `/alerts/${expected}?${scope}`)).status)
				.toBe(200);
		}
		for (const id of ["alr_b", "alr_sys"]) {
			expect
				.soft(
					(await api.request("GET", `/alerts/${id}?${projectScope}`)).status,
				)
				.toBe(404);
		}
		expect
			.soft((await api.request("GET", "/alerts/alr_a?scope=deployment")).status)
			.toBe(404);
		for (const path of ["/alerts", "/alerts/alr_a"]) {
			expect
				.soft(
					(await api.request("GET", `${path}?scope=deployment&${projectScope}`))
						.status,
				)
				.toBe(400);
		}
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
