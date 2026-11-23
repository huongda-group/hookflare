import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
	AcquireRequest,
	DestinationLimiter,
} from "../../src/delivery/limiter";

let n = 0;
/** A fresh DO per test: the namespace is shared by the whole run. */
function stub() {
	return env.LIMITER.get(env.LIMITER.idFromName(`test-${Date.now()}-${n++}`));
}
const at = (s: ReturnType<typeof stub>, req: AcquireRequest, now: number) =>
	runInDurableObject(s, (o: DestinationLimiter) => o.acquireAt(req, now));
const rel = (s: ReturnType<typeof stub>, id: string) =>
	runInDurableObject(s, (o: DestinationLimiter) => o.releaseSlot(id));

const T0 = 1_800_000_000_000;
const inFlight2 = { maxInFlight: 2, ratePerS: null, leaseMs: 40_000 };

describe("DestinationLimiter", () => {
	it("rejects at max_in_flight and accepts after a release", async () => {
		const s = stub();
		const a = await at(s, inFlight2, T0);
		const b = await at(s, inFlight2, T0);
		const c = await at(s, inFlight2, T0);
		expect(a.ok && b.ok).toBe(true);
		// The earliest slot expires 40 s away; waiting for it would idle the backend.
		expect(c).toEqual({ ok: false, reason: "in_flight", retryAfterMs: 5_000 });
		if (!a.ok) throw new Error("unreachable");
		await rel(s, a.slotId);
		expect((await at(s, inFlight2, T0)).ok).toBe(true);
	});

	it("frees a slot once its lease expires", async () => {
		const s = stub();
		await at(s, inFlight2, T0);
		await at(s, inFlight2, T0 + 1_000);
		const blocked = await at(s, inFlight2, T0 + 37_000);
		// Earliest slot expires at T0 + 40 s: 3 s away.
		expect(blocked).toEqual({
			ok: false,
			reason: "in_flight",
			retryAfterMs: 3_000,
		});
		expect((await at(s, inFlight2, T0 + 40_000)).ok).toBe(true);
	});

	it("caps the in-flight wait at 5 s, since a release usually comes before the expiry", async () => {
		const s = stub();
		await at(s, { ...inFlight2, maxInFlight: 1 }, T0);
		for (const dt of [0, 20_000, 34_999]) {
			const r = await at(s, { ...inFlight2, maxInFlight: 1 }, T0 + dt);
			expect(r).toEqual({
				ok: false,
				reason: "in_flight",
				retryAfterMs: 5_000,
			});
		}
	});

	it("allows a burst of ratePerS, then refills continuously", async () => {
		const s = stub();
		const rate = { maxInFlight: null, ratePerS: 5, leaseMs: 40_000 };
		for (let i = 0; i < 5; i++) expect((await at(s, rate, T0)).ok).toBe(true);
		expect(await at(s, rate, T0)).toEqual({
			ok: false,
			reason: "rate",
			retryAfterMs: 200,
		});
		// 200 ms later exactly one token is back.
		expect((await at(s, rate, T0 + 200)).ok).toBe(true);
		expect((await at(s, rate, T0 + 200)).ok).toBe(false);
	});

	it("spreads rate rejections over successive token times", async () => {
		const s = stub();
		const rate = { maxInFlight: null, ratePerS: 5, leaseMs: 40_000 };
		for (let i = 0; i < 5; i++) await at(s, rate, T0);
		const waits = [];
		for (let i = 0; i < 3; i++) {
			const r = await at(s, rate, T0);
			waits.push(r.ok ? 0 : r.retryAfterMs);
		}
		expect(waits).toEqual([200, 400, 600]);
		// Rejections reserve nothing: a token is still back after 200 ms.
		expect((await at(s, rate, T0 + 200)).ok).toBe(true);
		// The next hint continues after the ones already given out.
		expect(await at(s, rate, T0 + 200)).toEqual({
			ok: false,
			reason: "rate",
			retryAfterMs: 600,
		});
	});

	it("caps the rate wait at 30 s and restarts the spread once it has passed", async () => {
		const s = stub();
		const rate = { maxInFlight: null, ratePerS: 1, leaseMs: 40_000 };
		await at(s, rate, T0);
		const waits = [];
		for (let i = 0; i < 32; i++) {
			const r = await at(s, rate, T0);
			waits.push(r.ok ? 0 : r.retryAfterMs);
		}
		expect(waits.slice(0, 3)).toEqual([1_000, 2_000, 3_000]);
		expect(waits.slice(-3)).toEqual([30_000, 30_000, 30_000]);
		expect((await at(s, rate, T0 + 60_000)).ok).toBe(true);
		expect(await at(s, rate, T0 + 60_000)).toEqual({
			ok: false,
			reason: "rate",
			retryAfterMs: 1_000,
		});
	});

	it("rejects new acquires after a limit is lowered below the slot count", async () => {
		const s = stub();
		const four = { ...inFlight2, maxInFlight: 4 };
		for (let i = 0; i < 3; i++) await at(s, four, T0);
		const lowered = await at(s, { ...four, maxInFlight: 2 }, T0);
		expect(lowered.ok).toBe(false);
	});

	it("ignores unknown slot IDs on release", async () => {
		const s = stub();
		await expect(rel(s, "nope")).resolves.toBeUndefined();
	});

	it("keeps state for a new stub of the same ID", async () => {
		const name = `same-${Date.now()}`;
		const one = env.LIMITER.get(env.LIMITER.idFromName(name));
		await at(one, { ...inFlight2, maxInFlight: 1 }, T0);
		const two = env.LIMITER.get(env.LIMITER.idFromName(name));
		expect((await at(two, { ...inFlight2, maxInFlight: 1 }, T0)).ok).toBe(
			false,
		);
	});

	it("serves acquire and release over RPC", async () => {
		const s = stub();
		const r = await s.acquire({
			maxInFlight: 1,
			ratePerS: null,
			leaseMs: 40_000,
		});
		expect(r.ok).toBe(true);
		if (r.ok) await s.release(r.slotId);
		expect(
			(await s.acquire({ maxInFlight: 1, ratePerS: null, leaseMs: 40_000 })).ok,
		).toBe(true);
	});
});
