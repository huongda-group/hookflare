import { describe, expect, it } from "vitest";
import { authHeaderName, verifiers } from "../../src/ingress/verify";

const secret = "test-source-secret-0123456789";
const body = new Uint8Array(new TextEncoder().encode('{"id":"evt_1"}'));

async function hmac(
	alg: "SHA-1" | "SHA-256" | "SHA-512",
	data: Uint8Array,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: alg },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}
const hex = (b: Uint8Array) =>
	[...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const OK = { ok: true };
const fail = (reason: string) => ({ ok: false, reason });

function input(
	headers: Record<string, string>,
	config: Record<string, unknown>,
	url = "https://gw/in/src_1",
) {
	return {
		headers: new Headers(headers),
		url: new URL(url),
		body,
		config,
		secret,
	};
}

describe("none verifier", () => {
	it("always passes", async () => {
		expect(
			await verifiers.none.verify({ ...input({}, {}), secret: null }),
		).toEqual(OK);
	});
});

describe("hmac verifier", () => {
	const config = { header: "x-sig", algorithm: "sha256", encoding: "hex" };

	it("accepts a valid hex signature, case-insensitively", async () => {
		const sig = hex(await hmac("SHA-256", body));
		expect(
			await verifiers.hmac.verify(input({ "x-sig": sig }, config)),
		).toEqual(OK);
		expect(
			await verifiers.hmac.verify(
				input({ "x-sig": sig.toUpperCase() }, config),
			),
		).toEqual(OK);
	});

	it("supports sha1/sha512, base64, and a prefix", async () => {
		const sig = b64(await hmac("SHA-512", body));
		const cfg = {
			header: "x-sig",
			algorithm: "sha512",
			encoding: "base64",
			prefix: "sha512=",
		};
		expect(
			await verifiers.hmac.verify(input({ "x-sig": `sha512=${sig}` }, cfg)),
		).toEqual(OK);
		expect(await verifiers.hmac.verify(input({ "x-sig": sig }, cfg))).toEqual(
			fail("bad_prefix"),
		);
		const sha1 = hex(await hmac("SHA-1", body));
		expect(
			await verifiers.hmac.verify(
				input({ "x-sig": sha1 }, { ...config, algorithm: "sha1" }),
			),
		).toEqual(OK);
	});

	it("verifies an empty body", async () => {
		const empty = new Uint8Array(new ArrayBuffer(0));
		const sig = hex(await hmac("SHA-256", empty));
		expect(
			await verifiers.hmac.verify({
				...input({ "x-sig": sig }, config),
				body: empty,
			}),
		).toEqual(OK);
	});

	it("rejects a missing header, a wrong signature, garbage, and a missing secret, with a reason", async () => {
		const sig = hex(await hmac("SHA-256", body));
		expect(await verifiers.hmac.verify(input({}, config))).toEqual(
			fail("missing_header"),
		);
		expect(
			await verifiers.hmac.verify(
				input({ "x-sig": `${sig.slice(0, -2)}00` }, config),
			),
		).toEqual(fail("mismatch"));
		expect(
			await verifiers.hmac.verify(input({ "x-sig": "not-hex!" }, config)),
		).toEqual(fail("bad_encoding"));
		expect(
			await verifiers.hmac.verify({
				...input({ "x-sig": sig }, config),
				secret: null,
			}),
		).toEqual(fail("missing_secret"));
	});
});

describe("token verifier", () => {
	it("checks a header token", async () => {
		const cfg = { in: "header", name: "x-token" };
		expect(
			await verifiers.token.verify(input({ "x-token": secret }, cfg)),
		).toEqual(OK);
		expect(
			await verifiers.token.verify(input({ "x-token": `${secret}x` }, cfg)),
		).toEqual(fail("mismatch"));
		expect(await verifiers.token.verify(input({}, cfg))).toEqual(
			fail("missing_header"),
		);
	});

	it("checks a query token", async () => {
		const cfg = { in: "query", name: "token" };
		expect(
			await verifiers.token.verify(
				input({}, cfg, `https://gw/in/src_1?token=${secret}`),
			),
		).toEqual(OK);
		expect(
			await verifiers.token.verify(
				input({}, cfg, "https://gw/in/src_1?token=nope"),
			),
		).toEqual(fail("mismatch"));
	});
});

describe("authHeaderName", () => {
	it("names the header that carries the credential", () => {
		expect(authHeaderName("hmac", { header: "Stripe-Signature" })).toBe(
			"stripe-signature",
		);
		expect(authHeaderName("token", { in: "header", name: "X-Token" })).toBe(
			"x-token",
		);
		expect(authHeaderName("token", { in: "query", name: "token" })).toBeNull();
		expect(authHeaderName("none", {})).toBeNull();
	});
});
