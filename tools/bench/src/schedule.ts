export type Step = {
	rate_per_s: number;
	duration_s: number;
};

/**
 * Open-loop arrival schedule: yields the send time in ms for each request
 * at a fixed spacing of `1000 / rate`. Each step continues from the end
 * time of the previous step. The run loop fires each request at its time
 * and never awaits the earlier ones.
 */
export function* arrivals(steps: Step[]): Generator<number> {
	let t = 0;
	for (const step of steps) {
		const spacing = 1000 / step.rate_per_s;
		const count = Math.round(step.rate_per_s * step.duration_s);
		for (let i = 0; i < count; i++) {
			yield t + i * spacing;
		}
		t += count * spacing;
	}
}
