export type SendResult = {
	status: number;
	ms: number;
};

export type Summary = {
	by_status: Record<string, number>;
	p50: number;
	p90: number;
	p99: number;
	count: number;
};

/**
 * Nearest-rank percentiles over the sorted latencies:
 * rank = ceil(p / 100 * n), clamped to [1, n].
 */
export function percentiles(
	latencies: number[],
	ps: number[],
): Record<string, number> {
	const sorted = [...latencies].sort((a, b) => a - b);
	const out: Record<string, number> = {};
	for (const p of ps) {
		if (sorted.length === 0) {
			out[`p${p}`] = 0;
			continue;
		}
		const rank = Math.min(
			sorted.length,
			Math.max(1, Math.ceil((p / 100) * sorted.length)),
		);
		out[`p${p}`] = sorted[rank - 1];
	}
	return out;
}

export function summarize(results: SendResult[]): Summary {
	const by_status: Record<string, number> = {};
	for (const r of results) {
		const key = String(r.status);
		by_status[key] = (by_status[key] ?? 0) + 1;
	}
	const p = percentiles(
		results.map((r) => r.ms),
		[50, 90, 99],
	);
	return {
		by_status,
		p50: p.p50,
		p90: p.p90,
		p99: p.p99,
		count: results.length,
	};
}
