import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	auditStmt,
	checkCreateProject,
	MAX_ADMIN_BODY_BYTES,
	readJson,
} from "../../src/admin/http";
import type { AppBindings } from "../../src/app";
import { auditLogs } from "../../src/core/db/schema";
import { testDeps } from "../helpers/deps";

const app = new Hono<AppBindings>().post("/", async (c) => {
	const body = await readJson(c, z.object({ name: z.string() }));
	return body.ok ? c.json(body.value) : body.response;
});

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

describe("readJson", () => {
	it("stops reading at the cap when there is no content-length", async () => {
		// Never ends: only a reader that enforces the cap while streaming returns.
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(MAX_ADMIN_BODY_BYTES / 4));
			},
		});
		const res = await app.request("/", {
			method: "POST",
			body: endless,
			// @ts-expect-error duplex is required for stream bodies but missing from RequestInit
			duplex: "half",
		});
		expect(res.status).toBe(413);
	});

	it("parses a streamed body under the cap", async () => {
		const res = await app.request("/", {
			method: "POST",
			body: streamOf(new TextEncoder().encode('{"name":"a"}')),
			// @ts-expect-error duplex is required for stream bodies but missing from RequestInit
			duplex: "half",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: "a" });
	});
});

describe("checkCreateProject", () => {
	const scoped = new Hono<AppBindings>().post("/", (c) => {
		const mismatch = checkCreateProject(c, "prj_a");
		return mismatch ?? c.text("ok");
	});

	it("accepts no scope or the matching scope", async () => {
		expect((await scoped.request("/", { method: "POST" })).status).toBe(200);
		expect(
			(await scoped.request("/?project_id=prj_a", { method: "POST" })).status,
		).toBe(200);
	});

	it("rejects a malformed or different scope with 400", async () => {
		const bad = await scoped.request("/?project_id=nope", { method: "POST" });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({
			issues: [expect.objectContaining({ path: "project_id" })],
		});
		const other = await scoped.request("/?project_id=prj_b", {
			method: "POST",
		});
		expect(other.status).toBe(400);
		expect(await other.json()).toMatchObject({
			issues: [
				{ path: "project_id", message: "Project must match the query scope" },
			],
		});
	});
});

describe("auditStmt", () => {
	it("refuses to build an audit row without an actor", async () => {
		const deps = testDeps();
		const resourceId = `res_${crypto.randomUUID()}`;
		const app = new Hono<AppBindings>()
			.use(async (c, next) => {
				c.set("deps", deps);
				await next();
			})
			.post("/", async (c) => {
				await deps.db.batch([
					auditStmt(c, {
						action: "project.created",
						resourceType: "project",
						resourceId,
					}),
				]);
				return c.text("ok");
			})
			.onError((err, c) => c.text(err.message, 500));
		const res = await app.request("/", { method: "POST" });
		expect(res.status).toBe(500);
		expect(await res.text()).toBe("auditStmt called without an actor");
		expect(
			await deps.db
				.select()
				.from(auditLogs)
				.where(eq(auditLogs.resourceId, resourceId)),
		).toEqual([]);
	});
});
