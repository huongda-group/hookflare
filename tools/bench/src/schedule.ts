export type Step = {
	rate_per_s: number;
	duration_s: number;
};

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
