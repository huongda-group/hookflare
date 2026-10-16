import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { apiUrl, server } from "@/test/server";
import { ApiError, api, isSessionExpired, qs } from "./api";

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

	it("treats an HTML answer as an expired session", async () => {
		server.use(
			http.get(
				apiUrl("/events"),
				() =>
					new HttpResponse("<html>login</html>", {
						headers: { "content-type": "text/html" },
					}),
			),
		);
		const err = await api.get("/events").catch((e) => e);
		expect(err).toMatchObject({ code: "session_expired" });
		expect(isSessionExpired()).toBe(true);
	});

	it("treats a network failure (CORS on the Access redirect) as an expired session", async () => {
		server.use(http.get(apiUrl("/events"), () => HttpResponse.error()));
		const err = await api.get("/events").catch((e) => e);
		expect(err).toMatchObject({ code: "session_expired" });
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
