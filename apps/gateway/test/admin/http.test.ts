import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { auditUrl, MAX_ADMIN_BODY_BYTES, readJson } from "../../src/admin/http";
import type { AppBindings } from "../../src/app";

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

describe("auditUrl", () => {
	it("keeps only the origin", () => {
		expect(
			auditUrl("https://hooks.slack.com/services/T0/B0/secret?token=abc"),
		).toBe("https://hooks.slack.com");
	});
});
