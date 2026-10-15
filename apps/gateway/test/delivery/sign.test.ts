import { describe, expect, it } from "vitest";
import { buildOutboundHeaders, signWebhook } from "../../src/delivery/sign";

const enc = (s: string) =>
	new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

describe("signWebhook", () => {
	it("matches the Standard Webhooks reference vector", async () => {
		const sig = await signWebhook({
			id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
			timestampSec: 1614265330,
			body: enc('{"test": 2432232314}'),
			secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
		});
		expect(sig).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
	});

	it("signs non-UTF-8 bytes exactly", async () => {
		const a = await signWebhook({
			id: "dlv_1",
			timestampSec: 1,
			body: new Uint8Array([0xff, 0x00]) as Uint8Array<ArrayBuffer>,
			secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
		});
		const b = await signWebhook({
			id: "dlv_1",
			timestampSec: 1,
			body: new Uint8Array([0xff, 0x01]) as Uint8Array<ArrayBuffer>,
			secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
		});
		expect(a).not.toBe(b);
	});
});

describe("buildOutboundHeaders", () => {
	it("keeps provider headers, drops denylisted ones, and adds webhook headers", () => {
		const h = buildOutboundHeaders({
			storedHeaders: {
				"content-type": "text/plain",
				"x-github-event": "push",
				authorization: "[REDACTED]",
				"x-sig": "[REDACTED]",
				cookie: "a=b",
				"x-api-key": "k",
				"proxy-authorization": "p",
				"cf-connecting-ip": "1.2.3.4",
				host: "gw.example.com",
				"content-length": "10",
				connection: "keep-alive",
				"transfer-encoding": "chunked",
				"webhook-id": "spoofed",
			},
			contentType: "application/json",
			deliveryId: "dlv_1",
			eventId: "evt_1",
			timestampSec: 1700000000,
			signature: "v1,abc",
		});
		expect(Object.fromEntries(h)).toEqual({
			"content-type": "application/json",
			"x-github-event": "push",
			"webhook-id": "dlv_1",
			"webhook-timestamp": "1700000000",
			"webhook-signature": "v1,abc",
			"x-webhook-event-id": "evt_1",
			"user-agent": "Hookflare/1",
		});
	});

	it("omits content-type when none was stored", () => {
		const h = buildOutboundHeaders({
			storedHeaders: {},
			contentType: null,
			deliveryId: "dlv_1",
			eventId: "evt_1",
			timestampSec: 1,
			signature: "v1,x",
		});
		expect(h.has("content-type")).toBe(false);
	});
});
