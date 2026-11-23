import { HttpResponse, http } from "msw";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiRaw, qs, subscribeUnauthorized } from "@/lib/api";
import { createQueryClient } from "@/router";
import { apiUrl, server } from "../helpers/server";

describe("api", () => {
	it("returns parsed JSON", async () => {
		server.use(
			http.get(apiUrl("/projects/prj_1"), () =>
				HttpResponse.json({ id: "prj_1" }),
			),
		);
		expect(await api.get("/projects/prj_1")).toEqual({ id: "prj_1" });
	});

	it("turns a JSON error into ApiError with issues", async () => {
		server.use(
			http.post(apiUrl("/projects"), () =>
				HttpResponse.json(
					{
						error: "invalid_request",
						issues: [{ path: "name", code: "invalid", message: "bad" }],
					},
					{ status: 400 },
				),
			),
		);
		const err = await api.post("/projects", {}).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({
			status: 400,
			code: "invalid_request",
			issues: [{ path: "name" }],
		});
	});

	it("fires the unauthorized listener on a 401 from a non-auth path", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
			),
		);
		const fired = vi.fn();
		const unsubscribe = subscribeUnauthorized(fired);
		const err = await api.get("/projects").catch((e) => e);
		expect(err).toMatchObject({ status: 401, code: "unauthorized" });
		expect(fired).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("does not fire the listener on a 401 from /auth/login", async () => {
		server.use(
			http.post(apiUrl("/auth/login"), () =>
				HttpResponse.json({ error: "invalid_credentials" }, { status: 401 }),
			),
		);
		const fired = vi.fn();
		const unsubscribe = subscribeUnauthorized(fired);
		const err = await api
			.postVoid("/auth/login", { username: "a", password: "b" })
			.catch((e) => e);
		expect(err).toMatchObject({ status: 401, code: "invalid_credentials" });
		expect(fired).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("maps a network failure to ApiError(0, network_error)", async () => {
		server.use(http.get(apiUrl("/events"), () => HttpResponse.error()));
		const err = await api.get("/events").catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toMatchObject({ status: 0, code: "network_error" });
	});

	it("builds query strings with repeated keys and skips empty values", () => {
		expect(
			qs({
				status: ["dead", "failed_final"],
				project_id: "prj_1",
				source_id: undefined,
				q: "",
			}),
		).toBe("?status=dead&status=failed_final&project_id=prj_1");
		expect(qs({})).toBe("");
	});
});

describe("dashboard write feedback", () => {
	beforeEach(() => {
		vi.spyOn(toast, "success").mockReturnValue("success-toast");
		vi.spyOn(toast, "error").mockReturnValue("error-toast");
	});

	afterEach(() => vi.restoreAllMocks());

	it.each([
		["/auth/setup", "Initial setup complete", "Could not complete setup"],
		["/auth/login", "Login session", "Could not log in"],
		["/auth/logout", "Logged out", "Could not log out"],
		["/me/password", "Password changed", "Could not change password"],
	] as const)(
		"reports the session or account action at %s",
		async (path, success, error) => {
			server.use(
				http.post(apiUrl(path), () => new HttpResponse(null, { status: 204 }), {
					once: true,
				}),
				http.post(apiUrl(path), () => new HttpResponse(null, { status: 400 })),
			);
			await api.postVoid(path);
			await expect(api.postVoid(path)).rejects.toBeInstanceOf(ApiError);
			expect(toast.success).toHaveBeenCalledExactlyOnceWith(success);
			expect(toast.error).toHaveBeenCalledExactlyOnceWith(error);
		},
	);

	it.each([
		["/projects/prj_1", { name: "New name" }, "Project updated"],
		["/projects/prj_1", { status: "active" }, "Project enabled"],
		["/sources/src_1", { status: "disabled" }, "Source disabled"],
		["/destinations/dst_1", { status: "disabled" }, "Destination disabled"],
		["/settings", { retry_defaults: {} }, "Retry defaults saved"],
		["/settings", { storage: {} }, "Storage settings saved"],
		["/settings", { alert_rules: {} }, "Alert rules saved"],
		["/users/name%2Fexample", { role: "viewer" }, "User role updated"],
		["/users/name%2Fexample", { disabled: false }, "User enabled"],
		["/alert-channels/ch_1", { enabled: false }, "Alert channel disabled"],
	] as const)(
		"distinguishes PATCH actions at %s with %j",
		async (path, body, message) => {
			server.use(http.patch(apiUrl(path), () => HttpResponse.json({})));
			await api.patch(path, body);
			expect(toast.success).toHaveBeenCalledExactlyOnceWith(message);
		},
	);

	it.each([
		["/projects", 201, "Project created"],
		["/sources", 201, "Source created"],
		["/destinations", 201, "Destination created"],
		["/destinations/dst_1/pause", 200, "Destination paused"],
		["/destinations/dst_1/resume", 200, "Destination resumed"],
		["/sources/src_1/rotate-secret", 200, "Source secret rotated"],
		[
			"/destinations/dst_1/rotate-secret",
			200,
			"Destination signing secret rotated",
		],
		["/destinations/dst_1/test", 201, "Test delivery finished"],
		["/alert-channels", 201, "Alert channel created"],
		["/alert-channels/ch_1/test", 200, "Alert channel test finished"],
		["/backups/run", 202, "Backup requested"],
		["/archives/run", 202, "Archive run requested"],
		["/users", 201, "User created"],
		["/users/name%2Fexample/password", 204, "User password reset"],
		["/users/name%2Fexample/tokens", 201, "API token created"],
		["/users/name%2Fexample/tokens/tok_1/revoke", 204, "API token revoked"],
	] as const)(
		"reports POST %s without exposing response data",
		async (path, status, message) => {
			server.use(
				http.post(apiUrl(path), () =>
					status === 204
						? new HttpResponse(null, { status })
						: HttpResponse.json({ ok: false, secret: "private" }, { status }),
				),
			);
			await apiRaw(path, { method: "POST" });
			expect(toast.success).toHaveBeenCalledExactlyOnceWith(message);
		},
	);

	it("reports deletion of an alert channel", async () => {
		server.use(
			http.delete(
				apiUrl("/alert-channels/ch_1"),
				() => new HttpResponse(null, { status: 204 }),
			),
		);
		await api.delete("/alert-channels/ch_1");
		expect(toast.success).toHaveBeenCalledExactlyOnceWith(
			"Alert channel deleted",
		);
	});

	it.each([
		["POST", http.post],
		["PUT", http.put],
		["DELETE", http.delete],
		["PATCH", http.patch],
	] as const)(
		"reports the outcome of a %s exactly once",
		async (method, handle) => {
			server.use(
				handle(
					apiUrl("/example"),
					() => new HttpResponse(null, { status: 204 }),
				),
				handle(apiUrl("/example/failure"), () =>
					HttpResponse.json({ error: "internal" }, { status: 500 }),
				),
			);

			expect((await apiRaw("/example", { method })).status).toBe(204);
			await expect(
				apiRaw("/example/failure", { method }),
			).rejects.toMatchObject({
				code: "internal",
				status: 500,
			});
			expect(toast.success).toHaveBeenCalledExactlyOnceWith(
				"Action completed.",
			);
			expect(toast.error).toHaveBeenCalledExactlyOnceWith("Action failed.");
		},
	);

	it("sends JSON with the PUT helper", async () => {
		server.use(
			http.put(apiUrl("/example"), async ({ request }) =>
				HttpResponse.json(await request.json()),
			),
		);
		expect(await api.put("/example", { enabled: true })).toEqual({
			enabled: true,
		});
	});

	it("does not announce read outcomes", async () => {
		server.use(
			http.get(apiUrl("/example"), () => HttpResponse.json({})),
			http.get(
				apiUrl("/example/failure"),
				() => new HttpResponse(null, { status: 500 }),
			),
		);
		await api.get("/example");
		await expect(api.get("/example/failure")).rejects.toBeInstanceOf(ApiError);
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("acknowledges a queued request without claiming the work is complete", async () => {
		server.use(
			http.post(apiUrl("/example"), () =>
				HttpResponse.json({ id: "job" }, { status: 202 }),
			),
		);
		expect(await api.post("/example")).toEqual({ id: "job" });
		expect(toast.success).toHaveBeenCalledExactlyOnceWith("Request accepted.");
	});

	it.each([
		["/events/evt_1/replay", 201],
		["/failures/replay", 200],
	] as const)(
		"acknowledges asynchronous replay at %s",
		async (path, status) => {
			server.use(
				http.post(apiUrl(path), () => new HttpResponse(null, { status })),
			);
			const response = await apiRaw(path, { method: "POST" });
			expect(response.status).toBe(status);
			expect(toast.success).toHaveBeenCalledExactlyOnceWith("Replay requested");
		},
	);

	it("announces a network failure without swallowing it", async () => {
		server.use(http.patch(apiUrl("/example"), () => HttpResponse.error()));
		await expect(api.patch("/example")).rejects.toMatchObject({
			status: 0,
			code: "network_error",
		});
		expect(toast.error).toHaveBeenCalledExactlyOnceWith(
			"Network error. Please try again.",
		);
	});

	it("announces a forbidden mutation once and invalidates the current user", async () => {
		server.use(
			http.delete(apiUrl("/example"), () =>
				HttpResponse.json({ error: "forbidden" }, { status: 403 }),
			),
		);
		const client = createQueryClient();
		client.setQueryData(["me"], { username: "admin" });
		const mutation = client.getMutationCache().build(client, {
			mutationFn: () => api.delete("/example"),
		});

		await expect(mutation.execute(undefined)).rejects.toMatchObject({
			status: 403,
		});
		expect(toast.error).toHaveBeenCalledExactlyOnceWith(
			"You do not have permission for that action.",
		);
		expect(client.getQueryState(["me"])?.isInvalidated).toBe(true);
		client.clear();
	});
});
