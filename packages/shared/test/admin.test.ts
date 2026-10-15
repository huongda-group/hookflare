import { describe, expect, it } from "vitest";
import {
	createDestinationRequest,
	createProjectRequest,
	createSourceRequest,
	eventIdConfigError,
	listQuery,
	patchDestinationRequest,
	patchSourceRequest,
} from "../src/admin";

const base = { project_id: "prj_1", destination_id: "dst_1", name: "Stripe" };
const hmac = {
	header: "stripe-signature",
	algorithm: "sha256",
	encoding: "hex",
};

describe("createProjectRequest", () => {
	it("accepts a valid slug and rejects bad ones", () => {
		expect(
			createProjectRequest.safeParse({ name: "Shop", slug: "shop-prod" })
				.success,
		).toBe(true);
		for (const slug of ["a", "-shop", "Shop", "shop_prod", "x".repeat(64)]) {
			expect(
				createProjectRequest.safeParse({ name: "Shop", slug }).success,
			).toBe(false);
		}
	});

	it("rejects unknown fields", () => {
		expect(
			createProjectRequest.safeParse({
				name: "Shop",
				slug: "shop",
				status: "active",
			}).success,
		).toBe(false);
	});
});

describe("createDestinationRequest / patchDestinationRequest", () => {
	it("bounds timeout_ms to 1000..30000", () => {
		const ok = { project_id: "prj_1", name: "B", url: "https://b.example.com" };
		expect(
			createDestinationRequest.safeParse({ ...ok, timeout_ms: 1000 }).success,
		).toBe(true);
		expect(
			createDestinationRequest.safeParse({ ...ok, timeout_ms: 999 }).success,
		).toBe(false);
		expect(
			createDestinationRequest.safeParse({ ...ok, timeout_ms: 30001 }).success,
		).toBe(false);
	});

	it("rejects status paused in M1", () => {
		expect(
			patchDestinationRequest.safeParse({ status: "paused" }).success,
		).toBe(false);
		expect(
			patchDestinationRequest.safeParse({ status: "disabled" }).success,
		).toBe(true);
	});
});

describe("createSourceRequest", () => {
	it("accepts none without secret and defaults auth_config/event_id_from", () => {
		const r = createSourceRequest.parse({ ...base, auth_type: "none" });
		expect(r).toMatchObject({ auth_config: {}, event_id_from: "none" });
	});

	it("forbids a secret with auth_type none", () => {
		expect(
			createSourceRequest.safeParse({
				...base,
				auth_type: "none",
				secret: "x".repeat(20),
			}).success,
		).toBe(false);
	});

	it("validates auth_config against auth_type", () => {
		expect(
			createSourceRequest.safeParse({
				...base,
				auth_type: "hmac",
				auth_config: hmac,
			}).success,
		).toBe(true);
		expect(
			createSourceRequest.safeParse({
				...base,
				auth_type: "hmac",
				auth_config: { in: "header", name: "x" },
			}).success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({
				...base,
				auth_type: "token",
				auth_config: { in: "query", name: "token" },
			}).success,
		).toBe(true);
		expect(
			createSourceRequest.safeParse({
				...base,
				auth_type: "hmac",
				auth_config: { ...hmac, algorithm: "md5" },
			}).success,
		).toBe(false);
	});

	it("bounds the secret to 16..512 characters", () => {
		const s = { ...base, auth_type: "hmac", auth_config: hmac };
		expect(
			createSourceRequest.safeParse({ ...s, secret: "x".repeat(15) }).success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({ ...s, secret: "x".repeat(16) }).success,
		).toBe(true);
		expect(
			createSourceRequest.safeParse({ ...s, secret: "x".repeat(513) }).success,
		).toBe(false);
	});

	it("checks event_id_selector against event_id_from", () => {
		const s = { ...base, auth_type: "none" };
		expect(
			createSourceRequest.safeParse({
				...s,
				event_id_from: "json_path",
				event_id_selector: "$.id",
			}).success,
		).toBe(true);
		expect(
			createSourceRequest.safeParse({
				...s,
				event_id_from: "json_path",
				event_id_selector: "id",
			}).success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({ ...s, event_id_from: "header" }).success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({ ...s, event_id_selector: "$.id" })
				.success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({
				...s,
				event_id_from: "header",
				event_id_selector: "x-event-id",
			}).success,
		).toBe(true);
	});

	it("bounds max_body_bytes to 1..65536", () => {
		const s = { ...base, auth_type: "none" };
		expect(
			createSourceRequest.safeParse({ ...s, max_body_bytes: 65536 }).success,
		).toBe(true);
		expect(
			createSourceRequest.safeParse({ ...s, max_body_bytes: 65537 }).success,
		).toBe(false);
		expect(
			createSourceRequest.safeParse({ ...s, max_body_bytes: 0 }).success,
		).toBe(false);
	});
});

describe("patchSourceRequest", () => {
	it("cannot change auth_type or the secret", () => {
		expect(patchSourceRequest.safeParse({ auth_type: "hmac" }).success).toBe(
			false,
		);
		expect(
			patchSourceRequest.safeParse({ secret: "x".repeat(20) }).success,
		).toBe(false);
	});

	it("allows clearing nullable fields", () => {
		expect(
			patchSourceRequest.safeParse({
				max_body_bytes: null,
				event_id_selector: null,
			}).success,
		).toBe(true);
	});
});

describe("eventIdConfigError", () => {
	it("returns null for valid combinations and a message otherwise", () => {
		expect(eventIdConfigError("none", null)).toBeNull();
		expect(eventIdConfigError("header", "x-id")).toBeNull();
		expect(eventIdConfigError("header", "bad header")).toMatch(/header/);
		expect(eventIdConfigError("none", "$.id")).toMatch(/omitted/);
		expect(eventIdConfigError("json_path", null)).toMatch(/required/);
	});
});

describe("listQuery", () => {
	it("coerces limit, defaults to 50, caps at 200", () => {
		expect(listQuery.parse({})).toMatchObject({ limit: 50 });
		expect(listQuery.parse({ limit: "10" })).toMatchObject({ limit: 10 });
		expect(listQuery.safeParse({ limit: "201" }).success).toBe(false);
		expect(listQuery.safeParse({ limit: "0" }).success).toBe(false);
	});
});
