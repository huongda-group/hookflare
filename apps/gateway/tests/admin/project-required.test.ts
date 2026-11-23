import { describe, expect, it } from "vitest";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";

describe("first project prerequisite", () => {
	it("does not give viewers permission to create the first project", async () => {
		const api = await adminApp(testDeps(), { role: "viewer" });
		const res = await api.request("POST", "/projects", {
			name: "First project",
		});
		expect(res.status).toBe(403);
	});

	it("blocks non-bootstrap routes for cookie and token credentials until a project exists", async () => {
		const deps = testDeps();
		const cookie = await adminApp(deps);
		const token = await adminApp(deps, { via: "token" });
		for (const api of [cookie, token]) {
			for (const [method, path] of [
				["GET", "/overview"],
				["POST", "/me/password"],
				["GET", "/projects/prj_01JZZZZZZZZZZZZZZZZZZZZZZZ"],
			]) {
				const res = await api.request(method, path);
				expect(res.status).toBe(409);
				expect(await res.json()).toEqual({ error: "project_required" });
			}
			const me = await api.request("GET", "/me");
			expect(me.status).toBe(200);
			expect(await me.json()).toMatchObject({ project_required: true });
			const listed = await api.request("GET", "/projects?limit=1");
			expect(listed.status).toBe(200);
			expect(await listed.json()).toEqual({ data: [], next_cursor: null });
		}
		const created = await cookie.request("POST", "/projects", {
			name: "First project",
		});
		expect(created.status).toBe(201);
		const { id } = await created.json<{ id: string }>();
		expect(
			(await cookie.request("PATCH", `/projects/${id}`, { status: "disabled" }))
				.status,
		).toBe(200);
		for (const api of [cookie, token]) {
			expect((await api.request("GET", "/overview")).status).toBe(200);
			expect(await (await api.request("GET", "/me")).json()).toMatchObject({
				project_required: false,
			});
		}
	});
});
