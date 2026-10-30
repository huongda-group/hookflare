import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import { testEnv } from "../helpers/env";
import { seedPipeline } from "../helpers/seed";

type Src = {
	id: string;
	destination_id: string;
	secret?: string;
	secret_fingerprint: string | null;
	ingress_url: string;
	event_id_from: string;
	event_id_selector: string | null;
	auth_config: unknown;
};

const hmac = { header: "x-signature", algorithm: "sha256", encoding: "hex" };

describe("admin sources", () => {
	beforeEach(() => {
		for (const m of ["log", "warn", "error"] as const)
			vi.spyOn(console, m).mockImplementation(() => {});
	});

	it("creates a none source with an ingress url and no secret", async () => {
		const deps = testDeps();
		const { project, destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const res = await api.request("POST", "/sources", {
			project_id: project.id,
			destination_id: destination.id,
			name: "Open",
			auth_type: "none",
			auth_config: {},
		});
		expect(res.status).toBe(201);
		const src = await res.json<Src>();
		expect(src.ingress_url).toBe(`https://hookflare.example.com/in/${src.id}`);
		expect(src.secret).toBeUndefined();
		expect(src.secret_fingerprint).toBeNull();
	});

	it("builds ingress_url from PUBLIC_BASE_URL when it is set", async () => {
		const deps = testDeps({
			env: testEnv({ PUBLIC_BASE_URL: "https://hooks.example.net/" }),
		});
		const { project, destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const res = await api.request("POST", "/sources", {
			project_id: project.id,
			destination_id: destination.id,
			name: "Open",
			auth_type: "none",
			auth_config: {},
		});
		const src = await res.json<Src>();
		expect(src.ingress_url).toBe(`https://hooks.example.net/in/${src.id}`);
	});

	it("returns a generated secret once, then only its fingerprint", async () => {
		const deps = testDeps();
		const { project, destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const src = await (
			await api.request("POST", "/sources", {
				project_id: project.id,
				destination_id: destination.id,
				name: "Stripe",
				auth_type: "hmac",
				auth_config: hmac,
			})
		).json<Src>();
		expect(src.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const got = await (await api.request("GET", `/sources/${src.id}`)).json<
			Src & Record<string, unknown>
		>();
		expect(got.secret).toBeUndefined();
		expect(got.secret_fingerprint).toBe(src.secret_fingerprint);
		expect(Object.keys(got).some((k) => k.endsWith("_enc"))).toBe(false);
	});

	it("does not echo a user-supplied secret", async () => {
		const deps = testDeps();
		const { project, destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const src = await (
			await api.request("POST", "/sources", {
				project_id: project.id,
				destination_id: destination.id,
				name: "GH",
				auth_type: "token",
				auth_config: { in: "header", name: "x-token" },
				secret: "a-user-supplied-secret",
			})
		).json<Src>();
		expect(src.secret).toBeUndefined();
		expect(src.secret_fingerprint).not.toBeNull();
	});

	it.each([
		[
			"a secret with auth_type none",
			{ auth_type: "none", auth_config: {}, secret: "0123456789abcdef" },
		],
		[
			"a short secret",
			{ auth_type: "hmac", auth_config: hmac, secret: "short" },
		],
		[
			"an auth_config of the wrong type",
			{ auth_type: "hmac", auth_config: { in: "header", name: "x" } },
		],
		[
			"json_path without a selector",
			{ auth_type: "none", auth_config: {}, event_id_from: "json_path" },
		],
		[
			"an invalid json path",
			{
				auth_type: "none",
				auth_config: {},
				event_id_from: "json_path",
				event_id_selector: "$..id",
			},
		],
		[
			"max_body_bytes above 10 MiB",
			{ auth_type: "none", auth_config: {}, max_body_bytes: 10_485_761 },
		],
	])("returns 400 for %s", async (_label, fields) => {
		const deps = testDeps();
		const { project, destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const res = await api.request("POST", "/sources", {
			project_id: project.id,
			destination_id: destination.id,
			name: "x",
			...fields,
		});
		expect(res.status).toBe(400);
	});

	it("returns 422 invalid_reference for a cross-project destination", async () => {
		const deps = testDeps();
		const a = await seedPipeline(deps);
		const b = await seedPipeline(deps);
		const api = await adminApp(deps);
		const res = await api.request("POST", "/sources", {
			project_id: a.project.id,
			destination_id: b.destination.id,
			name: "x",
			auth_type: "none",
			auth_config: {},
		});
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({
			error: "invalid_reference",
			field: "destination_id",
		});
	});

	it("rejects a cross-project destination_id patch", async () => {
		const deps = testDeps();
		const a = await seedPipeline(deps);
		const b = await seedPipeline(deps);
		const api = await adminApp(deps);
		const res = await api.request("PATCH", `/sources/${a.source.id}`, {
			destination_id: b.destination.id,
		});
		expect(res.status).toBe(422);
		const got = await (
			await api.request("GET", `/sources/${a.source.id}`)
		).json<Src>();
		expect(got.destination_id).toBe(a.destination.id);
	});

	it("checks a patched auth_config against the stored auth_type and forbids auth_type/secret", async () => {
		const deps = testDeps();
		const { source } = await seedPipeline(deps, {
			source: { authType: "hmac", authConfig: hmac },
		});
		const api = await adminApp(deps);
		expect(
			(
				await api.request("PATCH", `/sources/${source.id}`, {
					auth_config: { in: "query", name: "t" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await api.request("PATCH", `/sources/${source.id}`, {
					auth_type: "none",
				})
			).status,
		).toBe(400);
		expect(
			(
				await api.request("PATCH", `/sources/${source.id}`, {
					secret: "0123456789abcdef",
				})
			).status,
		).toBe(400);
		const ok = await api.request("PATCH", `/sources/${source.id}`, {
			auth_config: { ...hmac, prefix: "sha256=" },
		});
		expect(ok.status).toBe(200);
		expect((await ok.json<Src>()).auth_config).toEqual({
			...hmac,
			prefix: "sha256=",
		});
	});

	it("validates event id settings against the merged row", async () => {
		const deps = testDeps();
		const { source } = await seedPipeline(deps);
		const api = await adminApp(deps);
		expect(
			(
				await api.request("PATCH", `/sources/${source.id}`, {
					event_id_from: "header",
				})
			).status,
		).toBe(400);
		const set = await api.request("PATCH", `/sources/${source.id}`, {
			event_id_from: "json_path",
			event_id_selector: "$.data.id",
		});
		expect(await set.json()).toMatchObject({
			event_id_from: "json_path",
			event_id_selector: "$.data.id",
		});
		expect(
			(
				await api.request("PATCH", `/sources/${source.id}`, {
					event_id_selector: "not a path",
				})
			).status,
		).toBe(400);
		const cleared = await api.request("PATCH", `/sources/${source.id}`, {
			event_id_from: "none",
		});
		expect(await cleared.json()).toMatchObject({
			event_id_from: "none",
			event_id_selector: null,
		});
	});

	it("lists sources filtered by project", async () => {
		const deps = testDeps();
		const a = await seedPipeline(deps);
		const b = await seedPipeline(deps);
		const api = await adminApp(deps);
		const list = await (
			await api.request("GET", `/sources?project_id=${a.project.id}`)
		).json<{ data: Src[] }>();
		expect(list.data.map((s) => s.id)).toEqual([a.source.id]);
		expect(list.data.map((s) => s.id)).not.toContain(b.source.id);
	});

	it("accepts max_body_bytes up to 10 MiB", async () => {
		const deps = testDeps();
		const { project, destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const ok = await api.request("POST", "/sources", {
			project_id: project.id,
			destination_id: destination.id,
			name: "Big",
			auth_type: "none",
			auth_config: {},
			max_body_bytes: 10_485_760,
		});
		expect(ok.status).toBe(201);
		const tooBig = await api.request("POST", "/sources", {
			project_id: project.id,
			destination_id: destination.id,
			name: "TooBig",
			auth_type: "none",
			auth_config: {},
			max_body_bytes: 10_485_761,
		});
		expect(tooBig.status).toBe(400);
	});
});
