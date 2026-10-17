import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliveries, destinations, settings } from "../../src/core/db/schema";
import { DnsError } from "../../src/core/dns";
import {
	clearRetryDefaultsCache,
	RETRY_DEFAULTS_KEY,
} from "../../src/core/settings";
import { clearSsrfCache } from "../../src/core/ssrf";
import { adminApp, auditRows, beforeNextBatch } from "../helpers/admin";
import { recordingQueue, testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

type Dest = {
	id: string;
	url: string;
	status: string;
	timeout_ms: number | null;
	max_attempts: number | null;
	backoff_base_s: number | null;
	backoff_max_s: number | null;
	max_in_flight: number | null;
	rate_limit_per_s: number | null;
	signing_secret?: string;
	signing_secret_fingerprint: string;
};

describe("admin destinations", () => {
	beforeEach(() => {
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

	it("never stores the signing secret or a full url in audit rows", async () => {
		const deps = testDeps();
		const { project, destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const created = await (
			await api.request("POST", "/destinations", {
				project_id: project.id,
				name: "Slack",
				url: "https://hooks.example.com/services/created-secret?token=q1",
			})
		).json<Dest>();
		await api.request("PATCH", `/destinations/${destination.id}`, {
			url: "https://hooks.example.com/services/patched-secret?token=q2",
		});
		const rows = [
			...(await auditRows(deps, created.id)),
			...(await auditRows(deps, destination.id)),
		];
		expect(rows.map((r) => r.action)).toEqual([
			"destination.created",
			"destination.updated",
		]);
		expect(rows.map((r) => r.diffJson?.url)).toEqual([
			"https://hooks.example.com",
			"https://hooks.example.com",
		]);
		const text = JSON.stringify(rows);
		expect(text).not.toContain(created.signing_secret as string);
		expect(text).not.toMatch(/secret\?token|q1|q2/);
	});

	it("audits pause and resume with an optional reason", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "operator" });
		expect(
			(
				await api.request("POST", `/destinations/${destination.id}/pause`, {
					reason: "backend deploy",
				})
			).status,
		).toBe(200);
		expect(
			(await api.request("POST", `/destinations/${destination.id}/resume`))
				.status,
		).toBe(200);
		const rows = await auditRows(deps, destination.id);
		expect(rows.map((r) => [r.action, r.reason])).toEqual([
			["destination.paused", "backend deploy"],
			["destination.resumed", null],
		]);
	});

	it("resets consecutive failures on resume and on a URL change only", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "admin" });
		const failures = async () =>
			(
				await deps.db
					.select({ n: destinations.consecutiveFailures })
					.from(destinations)
					.where(eq(destinations.id, destination.id))
			)[0]?.n;
		const fail = (n: number) =>
			deps.db
				.update(destinations)
				.set({ consecutiveFailures: n })
				.where(eq(destinations.id, destination.id));

		await fail(7);
		await api.request("POST", `/destinations/${destination.id}/pause`);
		expect(await failures()).toBe(7);
		await api.request("POST", `/destinations/${destination.id}/resume`);
		expect(await failures()).toBe(0);

		await fail(4);
		await api.request("PATCH", `/destinations/${destination.id}`, {
			name: "renamed",
		});
		expect(await failures()).toBe(4);
		const res = await api.request("PATCH", `/destinations/${destination.id}`, {
			url: "https://hooks.example.com/services/moved",
		});
		expect(res.status).toBe(200);
		expect(await failures()).toBe(0);
	});

	it("does not audit a pause of an already paused destination", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps, {
			destination: { status: "paused" },
		});
		const api = await adminApp(deps);
		expect(
			(await api.request("POST", `/destinations/${destination.id}/pause`))
				.status,
		).toBe(200);
		expect(await auditRows(deps, destination.id)).toEqual([]);
	});

	it("does not audit a pause that loses the race to another pause", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		await api.request("GET", "/me"); // bootstrap batch happens here
		beforeNextBatch(deps, () =>
			deps.db
				.update(destinations)
				.set({ status: "paused" })
				.where(eq(destinations.id, destination.id)),
		);
		const res = await api.request(
			"POST",
			`/destinations/${destination.id}/pause`,
		);
		expect(res.status).toBe(200);
		expect(await auditRows(deps, destination.id)).toEqual([]);
	});

	it("does not audit a resume that loses the race to another resume", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps, {
			destination: { status: "paused" },
		});
		const api = await adminApp(deps);
		await api.request("GET", "/me");
		beforeNextBatch(deps, () =>
			deps.db
				.update(destinations)
				.set({ status: "active" })
				.where(eq(destinations.id, destination.id)),
		);
		const res = await api.request(
			"POST",
			`/destinations/${destination.id}/resume`,
		);
		expect(res.status).toBe(200);
		expect(await auditRows(deps, destination.id)).toEqual([]);
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

	async function create(
		api: Awaited<ReturnType<typeof adminApp>>,
		projectId: string,
		extra = {},
	) {
		return api.request("POST", "/destinations", {
			project_id: projectId,
			name: "API",
			url: "https://api.example.com/hooks",
			...extra,
		});
	}

	it("stores, returns, and resets the retry policy", async () => {
		const deps = testDeps();
		const { project } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const created = await (
			await create(api, project.id, {
				max_attempts: 5,
				backoff_base_s: 10,
				backoff_max_s: 600,
			})
		).json<Dest>();
		expect(created).toMatchObject({
			max_attempts: 5,
			backoff_base_s: 10,
			backoff_max_s: 600,
		});
		const patched = await (
			await api.request("PATCH", `/destinations/${created.id}`, {
				max_attempts: null,
			})
		).json<Dest>();
		expect(patched.max_attempts).toBeNull();
		expect(patched.backoff_max_s).toBe(600);
	});

	it.each([
		[{ max_attempts: 0 }],
		[{ max_attempts: 51 }],
		[{ backoff_base_s: 3601 }],
		[{ backoff_max_s: 43_201 }],
		[{ backoff_max_s: 10 }],
		[{ backoff_base_s: 100, backoff_max_s: 50 }],
	])("rejects an invalid policy %j", async (extra) => {
		const deps = testDeps();
		const { project } = await seedPipeline(deps);
		const api = await adminApp(deps);
		expect((await create(api, project.id, extra)).status).toBe(400);
	});

	it("rejects a null reset that makes base exceed max", async () => {
		const deps = testDeps();
		const { project } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const d = await (
			await create(api, project.id, { backoff_base_s: 5, backoff_max_s: 10 })
		).json<Dest>();
		const res = await api.request("PATCH", `/destinations/${d.id}`, {
			backoff_base_s: null,
		});
		expect(res.status).toBe(400);
		const after = await (
			await api.request("GET", `/destinations/${d.id}`)
		).json<Dest>();
		expect(after.backoff_base_s).toBe(5);
	});

	it("accepts unrelated patches after raised defaults exceed the own max", async () => {
		const deps = testDeps();
		const { project } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const d = await (
			await create(api, project.id, { backoff_max_s: 60 })
		).json<Dest>();
		try {
			expect(
				(
					await api.request("PATCH", "/settings", {
						retry_defaults: {
							timeout_ms: 10_000,
							max_attempts: 8,
							backoff_base_s: 120,
							backoff_max_s: 3600,
						},
					})
				).status,
			).toBe(200);
			const renamed = await api.request("PATCH", `/destinations/${d.id}`, {
				name: "renamed",
			});
			expect(renamed.status).toBe(200);
			const disabled = await api.request("PATCH", `/destinations/${d.id}`, {
				status: "disabled",
			});
			expect(disabled.status).toBe(200);
			// Touching the backoff fields still validates against the defaults.
			const touched = await api.request("PATCH", `/destinations/${d.id}`, {
				backoff_max_s: 90,
			});
			expect(touched.status).toBe(400);
		} finally {
			await deps.db
				.delete(settings)
				.where(eq(settings.key, RETRY_DEFAULTS_KEY));
			clearRetryDefaultsCache();
		}
	});

	it("pauses idempotently, refuses a disabled destination, and resumes", async () => {
		const deps = testDeps({ queue: recordingQueue() });
		const p = await seedPipeline(deps);
		const api = await adminApp(deps);
		const pause = () =>
			api.request("POST", `/destinations/${p.destination.id}/pause`);
		expect((await (await pause()).json<Dest>()).status).toBe("paused");
		expect((await pause()).status).toBe(200);

		const resumed = await api.request(
			"POST",
			`/destinations/${p.destination.id}/resume`,
		);
		expect(resumed.status).toBe(200);
		expect(await resumed.json()).toMatchObject({
			destination: { status: "active" },
			resumed: 0,
		});

		await api.request("PATCH", `/destinations/${p.destination.id}`, {
			status: "disabled",
		});
		expect((await pause()).status).toBe(409);
		expect(
			(await api.request("POST", `/destinations/${p.destination.id}/resume`))
				.status,
		).toBe(409);
	});

	it("resume moves at most 100 paused deliveries and enqueues them", async () => {
		const queue = recordingQueue();
		const deps = testDeps({ queue });
		const p = await seedPipeline(deps, { destination: { status: "paused" } });
		for (let i = 0; i < 101; i++)
			await seedDelivery(deps, p, { status: "paused" });
		const api = await adminApp(deps);
		const res = await api.request(
			"POST",
			`/destinations/${p.destination.id}/resume`,
		);
		expect(await res.json()).toMatchObject({ resumed: 100 });
		expect(queue.sent).toHaveLength(100);
		const rows = await deps.db
			.select({ status: deliveries.status })
			.from(deliveries)
			.where(eq(deliveries.destinationId, p.destination.id));
		expect(rows.filter((r) => r.status === "queued")).toHaveLength(100);
		expect(rows.filter((r) => r.status === "paused")).toHaveLength(1);
	});

	it("PATCH status active works from paused; paused is not accepted by PATCH", async () => {
		const deps = testDeps();
		const p = await seedPipeline(deps, { destination: { status: "paused" } });
		const api = await adminApp(deps);
		expect(
			(
				await api.request("PATCH", `/destinations/${p.destination.id}`, {
					status: "paused",
				})
			).status,
		).toBe(400);
		const res = await api.request(
			"PATCH",
			`/destinations/${p.destination.id}`,
			{ status: "active" },
		);
		expect((await res.json<Dest>()).status).toBe("active");
	});

	it("creates, reads, and clears limits, and audits the change", async () => {
		const deps = testDeps();
		const { project } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const created = await api.request("POST", "/destinations", {
			project_id: project.id,
			name: "limited",
			url: "https://example.com/hook",
			max_in_flight: 4,
			rate_limit_per_s: 10,
		});
		expect(created.status).toBe(201);
		const dst = await created.json<Dest>();
		expect(dst.max_in_flight).toBe(4);
		expect(dst.rate_limit_per_s).toBe(10);

		const patched = await api.request("PATCH", `/destinations/${dst.id}`, {
			max_in_flight: null,
		});
		expect(patched.status).toBe(200);
		const after = await patched.json<Dest>();
		expect(after.max_in_flight).toBeNull();
		expect(after.rate_limit_per_s).toBe(10);

		const audits = await auditRows(deps, dst.id);
		const update = audits.find((a) => a.action === "destination.updated");
		expect(update?.diffJson).toMatchObject({ max_in_flight: null });
	});

	it("rejects out-of-range limits", async () => {
		const deps = testDeps();
		const { project } = await seedPipeline(deps);
		const res = await (await adminApp(deps)).request("POST", "/destinations", {
			project_id: project.id,
			name: "bad",
			url: "https://example.com/hook",
			rate_limit_per_s: 0,
		});
		expect(res.status).toBe(400);
		expect(
			(await res.json<{ issues: { path: string }[] }>()).issues[0].path,
		).toBe("rate_limit_per_s");
	});
});
