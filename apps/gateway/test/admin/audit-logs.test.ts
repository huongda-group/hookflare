import type { AuditLog, Page } from "@hookflare/shared";
import { describe, expect, it } from "vitest";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";

describe("GET /audit-logs", () => {
	it("filters by actor, resource, and action, newest first, with a cursor", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "admin" });
		const created: string[] = [];
		for (const name of ["one", "two", "three"]) {
			const res = await api.request("POST", "/projects", {
				name,
				slug: `${name}-${crypto.randomUUID().slice(0, 6)}`,
			});
			created.push((await res.json<{ id: string }>()).id);
		}
		const base = `/audit-logs?actor=${encodeURIComponent(api.username)}&action=project.created`;
		const first = await (await api.request("GET", `${base}&limit=2`)).json<
			Page<AuditLog>
		>();
		const second = await (
			await api.request("GET", `${base}&limit=2&cursor=${first.next_cursor}`)
		).json<Page<AuditLog>>();
		expect([...first.data, ...second.data].map((a) => a.resource_id)).toEqual(
			[...created].reverse(),
		);
		expect(second.next_cursor).toBeNull();
		const one = await (
			await api.request(
				"GET",
				`/audit-logs?resource_type=project&resource_id=${created[0]}`,
			)
		).json<Page<AuditLog>>();
		expect(one.data).toHaveLength(1);
		expect(one.data[0]).toMatchObject({
			action: "project.created",
			actor: api.username,
		});
	});

	it("rejects a bad cursor and is admin only", async () => {
		const deps = testDeps();
		const admin = await adminApp(deps, { role: "admin" });
		expect((await admin.request("GET", "/audit-logs?cursor=@@")).status).toBe(
			400,
		);
		const op = await adminApp(deps, { role: "operator" });
		expect((await op.request("GET", "/audit-logs")).status).toBe(403);
	});
});
