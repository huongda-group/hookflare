/** How a send ended: an HTTP response, a client timeout, or a network error. */
export type SendKind = "http" | "timeout" | "network";

export type SendResult = {
	/** HTTP status, or 0 when no response arrived. */
	status: number;
	kind: SendKind;
	/**
	 * Latency from the scheduled send time (not the actual start), so a
	 * stalled sender cannot hide queueing delay (coordinated omission).
	 */
	ms: number;
	/** Actual send start minus scheduled time, in ms (>= 0 when late). */
	late_ms: number;
	/** Actual send start relative to the run's t0, in ms. */
	sent_at: number;
};

export type Summary = {
	/** Keyed by HTTP status, plus "timeout" and "network". */
	by_status: Record<string, number>;
	errors: {
		timeout: number;
		network: number;
		http_4xx: number;
		http_5xx: number;
	};
	p50: number;
	p90: number;
	p99: number;
	count: number;
	scheduled_rate_per_s: number | null;
	/** Sends per second actually achieved, from first to last send start. */
	actual_rate_per_s: number | null;
	lateness_ms: { p50: number; p99: number; max: number };
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

/** Achieved send rate: (count - 1) intervals over first-to-last start. */
export function actualRate(sentAt: number[]): number | null {
	if (sentAt.length < 2) return null;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const t of sentAt) {
		if (t < min) min = t;
		if (t > max) max = t;
	}
	if (max <= min) return null;
	return ((sentAt.length - 1) * 1000) / (max - min);
}

export function summarize(
	results: SendResult[],
	scheduledRatePerS: number | null = null,
): Summary {
	const by_status: Record<string, number> = {};
	const errors = { timeout: 0, network: 0, http_4xx: 0, http_5xx: 0 };
	for (const r of results) {
		const key = r.kind === "http" ? String(r.status) : r.kind;
		by_status[key] = (by_status[key] ?? 0) + 1;
		if (r.kind === "timeout") errors.timeout++;
		else if (r.kind === "network") errors.network++;
		else if (r.status >= 500) errors.http_5xx++;
		else if (r.status >= 400) errors.http_4xx++;
	}
	const p = percentiles(
		results.map((r) => r.ms),
		[50, 90, 99],
	);
	const late = results.map((r) => Math.max(0, r.late_ms));
	const lp = percentiles(late, [50, 99]);
	return {
		by_status,
		errors,
		p50: p.p50,
		p90: p.p90,
		p99: p.p99,
		count: results.length,
		scheduled_rate_per_s: scheduledRatePerS,
		actual_rate_per_s: actualRate(results.map((r) => r.sent_at)),
		lateness_ms: {
			p50: lp.p50,
			p99: lp.p99,
			max: late.reduce((a, b) => Math.max(a, b), 0),
		},
	};
}
