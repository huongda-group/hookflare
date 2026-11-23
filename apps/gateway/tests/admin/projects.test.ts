import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp, auditRows } from "../helpers/admin";
import { testDeps } from "../helpers/deps";

describe("admin projects", () => {
	beforeEach(() => {
		for (const m of ["log", "warn", "error"] as const)
			vi.spyOn(console, m).mockImplementation(() => {});
	});

	it("creates, gets, and patches a project", async () => {
		const api = await adminApp(testDeps());
		const created = await api.request("POST", "/projects", {
			name: "Shop",
		});
		expect(created.status).toBe(201);
		const project = await created.json<{ id: string; status: string }>();
		expect(project).toMatchObject({ name: "Shop", status: "active" });
		expect(project.id).toMatch(/^prj_/);
		expect(project).not.toHaveProperty("slug");

		const got = await api.request("GET", `/projects/${project.id}`);
		expect(await got.json()).toEqual(project);
		const list = await api.request("GET", "/projects");
		const { data } = await list.json<{
			data: { id: string }[];
		}>();
		expect(data.find((row) => row.id === project.id)).toEqual(project);

		const patched = await api.request("PATCH", `/projects/${project.id}`, {
			status: "disabled",
		});
		expect(patched.status).toBe(200);
		expect(await patched.json()).toMatchObject({
			id: project.id,
			status: "disabled",
		});
	});

	it("assigns distinct IDs to projects with the same name", async () => {
		const api = await adminApp(testDeps());
		const first = await api.request("POST", "/projects", { name: "Shop" });
		const second = await api.request("POST", "/projects", { name: "Shop" });
		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		const { id } = await first.json<{ id: string }>();
		expect(id).toMatch(/^prj_/);
		const duplicate = await second.json<{ id: string }>();
		expect(duplicate.id).toMatch(/^prj_/);
		expect(duplicate.id).not.toBe(id);
	});

	it("returns 400 for malformed JSON and unknown fields", async () => {
		const api = await adminApp(testDeps());
		const malformed = await api.request("POST", "/projects", "{not json");
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: "invalid_request" });
		const unknown = await api.request("POST", "/projects", {
			name: "A",
			owner: "x",
		});
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toMatchObject({
			error: "invalid_request",
			issues: expect.any(Array),
		});
		const invalidName = await api.request("POST", "/projects", {
			name: "",
		});
		expect(invalidName.status).toBe(400);
		const legacy = await api.request("POST", "/projects", {
			name: "Shop",
			slug: "shop",
		});
		expect(legacy.status).toBe(400);
	});

	it("rejects an invalid PATCH with 400 and leaves the project unchanged", async () => {
		const api = await adminApp(testDeps());
		const project = await (
			await api.request("POST", "/projects", { name: "Keep" })
		).json<{ id: string }>();
		const res = await api.request("PATCH", `/projects/${project.id}`, {
			status: "archived",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_request" });
		expect(
			await (await api.request("GET", `/projects/${project.id}`)).json(),
		).toMatchObject({ name: "Keep", status: "active" });
	});

	it("returns 413 for a body above 64 KiB", async () => {
		const api = await adminApp(testDeps());
		const res = await api.request("POST", "/projects", {
			name: "x".repeat(65_536),
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "payload_too_large" });
	});

	it("returns 404 for an unknown project", async () => {
		const api = await adminApp(testDeps());
		expect(
			(await api.request("GET", "/projects/prj_01JZZZZZZZZZZZZZZZZZZZZZZZ"))
				.status,
		).toBe(404);
		expect(
			(
				await api.request("PATCH", "/projects/prj_01JZZZZZZZZZZZZZZZZZZZZZZZ", {
					name: "x",
				})
			).status,
		).toBe(404);
	});

	it("paginates by id descending with a cursor", async () => {
		const api = await adminApp(testDeps());
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			ids.push(
				(
					await (
						await api.request("POST", "/projects", {
							name: `P${i}`,
						})
					).json<{ id: string }>()
				).id,
			);
		}
		const first = await (await api.request("GET", "/projects?limit=2")).json<{
			data: { id: string }[];
			next_cursor: string | null;
		}>();
		expect(first.data).toHaveLength(2);
		expect(first.data[0].id > first.data[1].id).toBe(true);
		expect(first.next_cursor).toBe(first.data[1].id);
		const second = await (
			await api.request("GET", `/projects?limit=2&cursor=${first.next_cursor}`)
		).json<{ data: { id: string }[] }>();
		expect(second.data.every((p) => p.id < first.data[1].id)).toBe(true);
		expect((await api.request("GET", "/projects?limit=500")).status).toBe(400);
	});

	it("writes an audit row with the actor and reason", async () => {
		const deps = testDeps();
		const api = await adminApp(deps);
		const res = await api.request("POST", "/projects", {
			name: "Audited",
			reason: "  new team  ",
		});
		const { id } = await res.json<{ id: string }>();
		const rows = await auditRows(deps, id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			actor: "admin@example.com",
			action: "project.created",
			resourceType: "project",
			reason: "new team",
		});
		expect(rows[0].diffJson).not.toHaveProperty("reason");
	});

	it("rejects a viewer with 403 and writes nothing", async () => {
		const deps = testDeps();
		const api = await adminApp(deps, { role: "viewer" });
		const res = await api.request("POST", "/projects", {
			name: "Nope",
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "forbidden",
			required: "config.write",
		});
		expect((await api.request("GET", "/projects")).status).toBe(200);
	});
});
