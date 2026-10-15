import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";

const slug = () => `p-${crypto.randomUUID().slice(0, 8)}`;

describe("admin projects", () => {
	beforeEach(() => {
		clearAccessKeyCache();
		for (const m of ["log", "warn", "error"] as const)
			vi.spyOn(console, m).mockImplementation(() => {});
	});

	it("creates, gets, and patches a project", async () => {
		const api = await adminApp(testDeps());
		const created = await api.request("POST", "/projects", {
			name: "Shop",
			slug: slug(),
		});
		expect(created.status).toBe(201);
		const project = await created.json<{ id: string; status: string }>();
		expect(project).toMatchObject({ name: "Shop", status: "active" });
		expect(project.id).toMatch(/^prj_/);

		const got = await api.request("GET", `/projects/${project.id}`);
		expect(await got.json()).toEqual(project);

		const patched = await api.request("PATCH", `/projects/${project.id}`, {
			status: "disabled",
		});
		expect(patched.status).toBe(200);
		expect(await patched.json()).toMatchObject({
			id: project.id,
			status: "disabled",
		});
	});

	it("returns 409 for a duplicate slug", async () => {
		const api = await adminApp(testDeps());
		const s = slug();
		expect(
			(await api.request("POST", "/projects", { name: "A", slug: s })).status,
		).toBe(201);
		const dup = await api.request("POST", "/projects", { name: "B", slug: s });
		expect(dup.status).toBe(409);
		expect(await dup.json()).toEqual({ error: "conflict" });
	});

	it("returns 400 for malformed JSON and unknown fields", async () => {
		const api = await adminApp(testDeps());
		const malformed = await api.request("POST", "/projects", "{not json");
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: "invalid_request" });
		const unknown = await api.request("POST", "/projects", {
			name: "A",
			slug: slug(),
			owner: "x",
		});
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toMatchObject({
			error: "invalid_request",
			issues: expect.any(Array),
		});
		const badSlug = await api.request("POST", "/projects", {
			name: "A",
			slug: "Bad Slug",
		});
		expect(badSlug.status).toBe(400);
	});

	it("returns 413 for a body above 64 KiB", async () => {
		const api = await adminApp(testDeps());
		const res = await api.request("POST", "/projects", {
			name: "x".repeat(65_536),
			slug: slug(),
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
							slug: slug(),
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

	it("logs an interim audit line with the actor", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const api = await adminApp(testDeps());
		const res = await api.request("POST", "/projects", {
			name: "Audited",
			slug: slug(),
		});
		const { id } = await res.json<{ id: string }>();
		const line = log.mock.calls
			.map((c) => String(c[0]))
			.find((l) => l.includes("admin.project.created"));
		expect(line).toBeDefined();
		expect(line).toContain("admin@example.com");
		expect(line).toContain(id);
	});
});
