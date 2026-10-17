/**
 * Offline cost estimator for bench scenarios and seeding. Every price and
 * per-operation constant lives in this file. Prices are list prices for
 * the Workers Paid plan as of 2026-10 and estimates are GROSS: they ignore
 * the monthly included quotas. Verify against current pricing
 * (https://developers.cloudflare.com/workers/platform/pricing/,
 * /d1/platform/pricing/, /queues/platform/pricing/,
 * /durable-objects/platform/pricing/, /r2/pricing/) before asking for run
 * approval.
 */

import { type Scenario, stepSink } from "./scenario.ts";
import { arrivals } from "./schedule.ts";

/** USD list prices. Verify against current pricing before relying on them. */
export const PRICING = {
	workersPerMillionRequests: 0.3,
	/** One message = write + read + delete = 3 operations. */
	queuesPerMillionOps: 0.4,
	d1PerMillionRowsWritten: 1.0,
	d1PerMillionRowsRead: 0.001,
	durableObjectsPerMillionRequests: 0.15,
	r2ClassAPerMillion: 4.5,
	r2ClassBPerMillion: 0.36,
} as const;

/**
 * D1 bills every index entry as a written row: one table row plus one per
 * index (webhook_events and deliveries have 5 indexes, delivery_attempts 2;
 * see apps/gateway/migrations).
 */
export const D1_ROWS_PER_INSERT = {
	webhook_events: 6,
	deliveries: 6,
	delivery_attempts: 3,
} as const;

/** Approximate per-operation counts of the pipeline. */
export const PIPELINE = {
	/** Ingress: event insert + delivery insert. */
	ingressRowsWritten:
		D1_ROWS_PER_INSERT.webhook_events + D1_ROWS_PER_INSERT.deliveries,
	/** Per attempt: lease update (~3) + attempt insert (3) + record update (~3). */
	attemptRowsWritten: 9,
	/** Ingress: source + destination lookups and the dedup probe. */
	ingressRowsRead: 3,
	/** Per attempt: delivery, event, destination, settings and the lease. */
	attemptRowsRead: 5,
	/** Per attempt: limiter acquire + release. */
	attemptDoRequests: 2,
	/** Each queue message is written, read, and deleted. */
	queueOpsPerMessage: 3,
	/** Payloads above this go to R2 (ingress INLINE_BODY_LIMIT). */
	inlineLimitBytes: 64 * 1024,
	/** Default destination max_attempts (apps/gateway/src/core/policy.ts). */
	maxAttempts: 20,
} as const;

/** Expected attempts per delivery when each attempt fails with `f`. */
export function expectedAttempts(
	failFraction: number,
	maxAttempts: number = PIPELINE.maxAttempts,
): number {
	let total = 0;
	for (let k = 0; k < maxAttempts; k++) total += failFraction ** k;
	return total;
}

export type CostEstimate = {
	requests: number;
	attempts: number;
	workers_requests: number;
	queue_ops: number;
	d1_rows_written: number;
	d1_rows_read: number;
	do_requests: number;
	r2_class_a: number;
	r2_class_b: number;
	usd: {
		workers: number;
		queues: number;
		d1_write: number;
		d1_read: number;
		durable_objects: number;
		r2: number;
		total: number;
	};
};

const perMillion = (count: number, price: number) => (count / 1e6) * price;

/**
 * Estimate one run of `scenario`. Each request costs an ingress Worker
 * request; each attempt costs a consumer invocation (conservative: batching
 * only lowers it), a sink request, one queue message, limiter DO calls,
 * and D1 rows. Attempts per request follow each step's sink `fail_pct`.
 */
export function estimateScenario(
	scenario: Scenario,
	opts: { maxAttempts?: number } = {},
): CostEstimate {
	const maxAttempts = opts.maxAttempts ?? PIPELINE.maxAttempts;
	let requests = 0;
	let attempts = 0;
	scenario.steps.forEach((step, index) => {
		const count = [...arrivals([step])].length;
		const fail = (stepSink(scenario, index).fail_pct ?? 0) / 100;
		requests += count;
		attempts += count * expectedAttempts(fail, maxAttempts);
	});
	const usesR2 = scenario.body_bytes > PIPELINE.inlineLimitBytes;
	const workers_requests = requests + 2 * attempts;
	const queue_ops = PIPELINE.queueOpsPerMessage * attempts;
	const d1_rows_written =
		requests * PIPELINE.ingressRowsWritten +
		attempts * PIPELINE.attemptRowsWritten;
	const d1_rows_read =
		requests * PIPELINE.ingressRowsRead + attempts * PIPELINE.attemptRowsRead;
	const do_requests = attempts * PIPELINE.attemptDoRequests;
	const r2_class_a = usesR2 ? requests : 0;
	const r2_class_b = usesR2 ? attempts : 0;
	const usd = {
		workers: perMillion(workers_requests, PRICING.workersPerMillionRequests),
		queues: perMillion(queue_ops, PRICING.queuesPerMillionOps),
		d1_write: perMillion(d1_rows_written, PRICING.d1PerMillionRowsWritten),
		d1_read: perMillion(d1_rows_read, PRICING.d1PerMillionRowsRead),
		durable_objects: perMillion(
			do_requests,
			PRICING.durableObjectsPerMillionRequests,
		),
		r2:
			perMillion(r2_class_a, PRICING.r2ClassAPerMillion) +
			perMillion(r2_class_b, PRICING.r2ClassBPerMillion),
		total: 0,
	};
	usd.total =
		usd.workers +
		usd.queues +
		usd.d1_write +
		usd.d1_read +
		usd.durable_objects +
		usd.r2;
	return {
		requests,
		attempts,
		workers_requests,
		queue_ops,
		d1_rows_written,
		d1_rows_read,
		do_requests,
		r2_class_a,
		r2_class_b,
		usd,
	};
}

/** D1 rows written (with index entries) and USD for a seed load. */
export function estimateSeed(rows: Record<string, number>): {
	d1_rows_written: number;
	usd: number;
} {
	let written = 0;
	for (const [table, count] of Object.entries(rows)) {
		const factor =
			D1_ROWS_PER_INSERT[table as keyof typeof D1_ROWS_PER_INSERT] ?? 1;
		written += count * factor;
	}
	return {
		d1_rows_written: written,
		usd: perMillion(written, PRICING.d1PerMillionRowsWritten),
	};
}

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const dollars = (n: number) => `$${n.toFixed(2)}`;

export function formatEstimate(e: CostEstimate): string {
	return [
		`requests          ${int(e.requests)}`,
		`attempts          ${int(e.attempts)}`,
		`workers requests  ${int(e.workers_requests)}  ${dollars(e.usd.workers)}`,
		`queue ops         ${int(e.queue_ops)}  ${dollars(e.usd.queues)}`,
		`d1 rows written   ${int(e.d1_rows_written)}  ${dollars(e.usd.d1_write)}`,
		`d1 rows read      ${int(e.d1_rows_read)}  ${dollars(e.usd.d1_read)}`,
		`do requests       ${int(e.do_requests)}  ${dollars(e.usd.durable_objects)}`,
		`r2 class A / B    ${int(e.r2_class_a)} / ${int(e.r2_class_b)}  ${dollars(e.usd.r2)}`,
		`total (gross)     ${dollars(e.usd.total)}`,
		"Gross list prices, included quotas ignored; verify against current pricing (tools/bench/src/cost.ts).",
	].join("\n");
}
