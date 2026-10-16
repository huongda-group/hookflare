import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setSleep, shardFor } from "../src/index";

const runId = () => `run_${crypto.randomUUID()}`;

function postHook(
	run: string,
	id: string | null,
	query = "",
): Promise<Response> {
	const headers = new Headers();
	if (id !== null) {
		headers.set("webhook-id", id);
	}
	return SELF.fetch(`https://sink.test/r/${run}/hook${query}`, {
		method: "POST",
		headers,
		body: "hello",
	});
}

async function statsOf(run: string): Promise<{
	status: number;
	body: Record<string, unknown>;
}> {
	const res = await SELF.fetch(`https://sink.test/r/${run}/stats`);
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

describe("sink", () => {
	it("records and merges across shards", async () => {
		const run = runId();
		for (let i = 0; i < 20; i++) {
			const res = await postHook(run, `msg_${i}`);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("ok");
		}
		for (let i = 0; i < 3; i++) {
			const res = await postHook(run, `msg_${i}`);
			expect(res.status).toBe(200);
		}
		const { status, body } = await statsOf(run);
		expect(status).toBe(200);
		expect(body.received).toBe(23);
		expect(body.unique).toBe(20);
		expect(body.duplicates).toBe(3);
		expect(body.by_status).toEqual({ 200: 23 });
		expect(typeof body.first_at).toBe("number");
		expect(typeof body.last_at).toBe("number");
		expect(body.first_at as number).toBeGreaterThan(0);
		expect(body.last_at as number).toBeGreaterThanOrEqual(
			body.first_at as number,
		);
	});

	it("status param", async () => {
		const run = runId();
		const res = await postHook(run, "msg_status", "?status=410");
		expect(res.status).toBe(410);
		expect(await res.text()).toBe("ok");
		const { body } = await statsOf(run);
		expect(body.by_status).toEqual({ 410: 1 });
	});

	it("fail_pct=100 always returns 503", async () => {
		const run = runId();
		for (let i = 0; i < 10; i++) {
			const res = await postHook(run, `msg_fail_${i}`, "?fail_pct=100");
			expect(res.status).toBe(503);
		}
	});

	it("fail_pct=0 never returns 503", async () => {
		const run = runId();
		for (let i = 0; i < 20; i++) {
			const res = await postHook(run, `msg_ok_${i}`, "?fail_pct=0");
			expect(res.status).toBe(200);
		}
	});

	it("delay_ms above 30000 is clamped to 30000", async () => {
		const seen: number[] = [];
		setSleep(async (ms: number) => {
			seen.push(ms);
		});
		try {
			const run = runId();
			const res = await postHook(run, "msg_delay", "?delay_ms=99999");
			expect(res.status).toBe(200);
			expect(seen).toEqual([30000]);
		} finally {
			setSleep(
				(ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
			);
		}
	});

	it("DELETE clears", async () => {
		const run = runId();
		await postHook(run, "msg_a");
		await postHook(run, "msg_b");
		const deleted = await SELF.fetch(`https://sink.test/r/${run}`, {
			method: "DELETE",
		});
		expect(deleted.status).toBe(204);
		const { status, body } = await statsOf(run);
		expect(status).toBe(200);
		expect(body.received).toBe(0);
		expect(body.unique).toBe(0);
		expect(body.duplicates).toBe(0);
		expect(body.by_status).toEqual({});
		expect(body.first_at).toBe(0);
		expect(body.last_at).toBe(0);
	});

	it("missing webhook-id", async () => {
		const run = runId();
		const res = await postHook(run, null);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toEqual({
			error: "missing_webhook_id",
		});
	});

	it("shardFor is stable", () => {
		const first = shardFor("msg_1");
		expect(shardFor("msg_1")).toBe(first);
		expect(first).toBeGreaterThanOrEqual(0);
		expect(first).toBeLessThanOrEqual(15);
	});

	it("unknown path returns 404", async () => {
		const res = await SELF.fetch("https://sink.test/nope");
		expect(res.status).toBe(404);
	});
});
