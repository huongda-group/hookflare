import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { DnsError } from "../../src/core/dns";
import { clearSsrfCache } from "../../src/core/ssrf";
import { adminApp } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import { seedPipeline } from "../helpers/seed";

type Dest = {
	id: string;
	url: string;
	status: string;
	timeout_ms: number | null;
	signing_secret?: string;
	signing_secret_fingerprint: string;
};

describe("admin destinations", () => {
	beforeEach(() => {
		clearAccessKeyCache();
		clearSsrfCache();
		for (const m of ["log", "warn", "error"] as const)
			vi.spyOn(console, m).mockImplementation(() => {});
	});

	it("returns the signing secret once, then only its fingerprint", async () => {
		const deps = testDeps();
		const { project } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const res = await api.request("POST", "/destinations", {
			project_id: project.id,
			name: "API",
			url: "https://api.example.com/hooks",
		});
		expect(res.status).toBe(201);
		const created = await res.json<Dest & Record<string, unknown>>();
		expect(created.signing_secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
		expect(created.signing_secret_fingerprint).toMatch(/^[0-9a-f]+$/);
		expect(Object.keys(created).some((k) => k.endsWith("_enc"))).toBe(false);

		const got = await (
			await api.request("GET", `/destinations/${created.id}`)
		).json<Dest>();
		expect(got.signing_secret).toBeUndefined();
		expect(got.signing_secret_fingerprint).toBe(
			created.signing_secret_fingerprint,
		);

		const list = await (
			await api.request("GET", `/destinations?project_id=${project.id}`)
		).json<{ data: Dest[] }>();
		expect(list.data.map((d) => d.id)).toContain(created.id);
		expect(list.data.every((d) => d.signing_secret === undefined)).toBe(true);
	});

	it("does not log the signing secret", async () => {
		const spies = (["log", "warn", "error"] as const).map((m) =>
			vi.spyOn(console, m).mockImplementation(() => {}),
		);
		const deps = testDeps();
		const { project } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const created = await (
			await api.request("POST", "/destinations", {
				project_id: project.id,
				name: "API",
				url: "https://api.example.com/x",
			})
		).json<Dest>();
		const all = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));
		expect(all.some((l) => l.includes("admin.destination.created"))).toBe(true);
		expect(all.some((l) => l.includes(created.signing_secret as string))).toBe(
			false,
		);
	});

	it("rejects unsafe urls with 422 and resolver failures with 503", async () => {
		const deps = testDeps({ resolveDns: async () => ["10.0.0.5"] });
		const { project } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const privateIp = await api.request("POST", "/destinations", {
			project_id: project.id,
			name: "x",
			url: "https://internal.example.com/",
		});
		expect(privateIp.status).toBe(422);
		expect(await privateIp.json()).toEqual({
			error: "unsafe_url",
			reason: "private_address",
		});
		const http = await api.request("POST", "/destinations", {
			project_id: project.id,
			name: "x",
			url: "http://api.example.com/",
		});
		expect([400, 422]).toContain(http.status);

		const failing = testDeps({
			resolveDns: async () => {
				throw new DnsError("resolver down");
			},
		});
		const { project: p2 } = await seedPipeline(failing);
		clearAccessKeyCache();
		const api2 = await adminApp(failing);
		const res = await api2.request("POST", "/destinations", {
			project_id: p2.id,
			name: "x",
			url: "https://api.example.com/",
		});
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "unavailable" });
	});

	it("returns 422 invalid_reference for an unknown project", async () => {
		const api = await adminApp(testDeps());
		const res = await api.request("POST", "/destinations", {
			project_id: "prj_01JZZZZZZZZZZZZZZZZZZZZZZZ",
			name: "x",
			url: "https://api.example.com/",
		});
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({
			error: "invalid_reference",
			field: "project_id",
		});
	});

	it("patches name, status, timeout, and url", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const res = await api.request("PATCH", `/destinations/${destination.id}`, {
			name: "Renamed",
			status: "disabled",
			timeout_ms: 5000,
			url: "https://new.example.com/hooks",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			name: "Renamed",
			status: "disabled",
			timeout_ms: 5000,
			url: "https://new.example.com/hooks",
		});
		const cleared = await api.request(
			"PATCH",
			`/destinations/${destination.id}`,
			{ timeout_ms: null },
		);
		expect(await cleared.json()).toMatchObject({ timeout_ms: null });
	});

	it("rejects an unsafe url patch and keeps the old url", async () => {
		const deps = testDeps({
			resolveDns: async (host) =>
				host === "evil.example.com" ? ["169.254.169.254"] : ["93.184.216.34"],
		});
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const res = await api.request("PATCH", `/destinations/${destination.id}`, {
			url: "https://evil.example.com/",
		});
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({
			error: "unsafe_url",
			reason: "private_address",
		});
		const got = await (
			await api.request("GET", `/destinations/${destination.id}`)
		).json<Dest>();
		expect(got.url).toBe(destination.url);
	});

	it("rejects status paused and secret changes in a patch", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		expect(
			(
				await api.request("PATCH", `/destinations/${destination.id}`, {
					status: "paused",
				})
			).status,
		).toBe(400);
		expect(
			(
				await api.request("PATCH", `/destinations/${destination.id}`, {
					signing_secret: "whsec_x",
				})
			).status,
		).toBe(400);
	});
});
