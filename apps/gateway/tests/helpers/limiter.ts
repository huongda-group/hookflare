import type { AcquireRequest, AcquireResult } from "../../src/delivery/limiter";
import type { Deps } from "../../src/deps";

/**
 * Scripted limiter: each acquire returns the next scripted result (the last one
 * repeats); "throw" rejects and "hang" never settles. Records every call.
 */
export function fakeLimiter(
	script: AcquireResult[] | "throw" | "hang" = [{ ok: true, slotId: "slot-1" }],
	options: { releaseFails?: boolean } = {},
) {
	const acquires: AcquireRequest[] = [];
	const releases: string[] = [];
	const destinations: string[] = [];
	let i = 0;
	const limiter: Deps["limiter"] = (destinationId) => {
		destinations.push(destinationId);
		return {
			async acquire(req) {
				acquires.push(req);
				if (script === "throw") throw new Error("DO unavailable");
				if (script === "hang") return new Promise<AcquireResult>(() => {});
				const r = script[Math.min(i, script.length - 1)];
				i++;
				return r;
			},
			async release(slotId) {
				releases.push(slotId);
				if (options.releaseFails) throw new Error("release failed");
			},
		};
	};
	return { limiter, acquires, releases, destinations };
}
