import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { apiUrl, server } from "@/test/server";
import { ApiError, api, qs, subscribeUnauthorized } from "./api";

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
						issues: [{ path: "slug", code: "invalid", message: "bad" }],
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
			issues: [{ path: "slug" }],
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
