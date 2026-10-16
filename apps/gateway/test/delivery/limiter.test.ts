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
		expect(c).toEqual({ ok: false, reason: "in_flight", retryAfterMs: 30_000 });
		if (!a.ok) throw new Error("unreachable");
		await rel(s, a.slotId);
		expect((await at(s, inFlight2, T0)).ok).toBe(true);
	});

	it("frees a slot once its lease expires", async () => {
		const s = stub();
		await at(s, inFlight2, T0);
		await at(s, inFlight2, T0 + 1_000);
		const blocked = await at(s, inFlight2, T0 + 30_000);
		// Earliest slot expires at T0 + 40 s: 10 s away.
		expect(blocked).toEqual({
			ok: false,
			reason: "in_flight",
			retryAfterMs: 10_000,
		});
		expect((await at(s, inFlight2, T0 + 40_000)).ok).toBe(true);
	});

	it("clamps the in-flight wait to 5 s at the short end", async () => {
		const s = stub();
		await at(s, { ...inFlight2, maxInFlight: 1 }, T0);
		const r = await at(s, { ...inFlight2, maxInFlight: 1 }, T0 + 39_000);
		expect(r).toEqual({ ok: false, reason: "in_flight", retryAfterMs: 5_000 });
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
