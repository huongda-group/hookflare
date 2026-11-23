import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/core/db/schema";
import type { Deps } from "../../src/deps";

/**
 * Fails a call whose text matches `match`: always (default), only on the
 * n-th match, or from the n-th match on. Faults wrap the raw bindings, so
 * production code has no test hooks (spec §10.1).
 */
export type FaultRule = {
	match: RegExp;
	on?: "always" | { nth: number } | { from: number };
	error?: Error;
};

function tripwire(rules: FaultRule[], label: string) {
	const counts = new Map<FaultRule, number>();
	return (text: string) => {
		for (const rule of rules) {
			if (!rule.match.test(text)) continue;
			const n = (counts.get(rule) ?? 0) + 1;
			counts.set(rule, n);
			const on = rule.on ?? "always";
			const fire =
				on === "always" || ("nth" in on ? n === on.nth : n >= on.from);
			if (fire)
				throw rule.error ?? new Error(`${label}: injected fault (${text})`);
		}
	};
}

function bound<T extends object>(target: T, prop: string | symbol) {
	const value = Reflect.get(target, prop, target);
	return typeof value === "function" ? value.bind(target) : value;
}

/** A batch fails when any of its statements matches. */
export function faultyD1(db: D1Database, rules: FaultRule[]): D1Database {
	const trip = tripwire(rules, "D1_ERROR");
	const real = new WeakMap<object, D1PreparedStatement>();
	const sqlOf = new WeakMap<object, string>();
	const wrap = (
		stmt: D1PreparedStatement,
		query: string,
	): D1PreparedStatement => {
		const proxy = new Proxy(stmt, {
			get(target, prop) {
				if (prop === "bind") {
					return (...args: unknown[]) => wrap(target.bind(...args), query);
				}
				if (
					prop === "run" ||
					prop === "all" ||
					prop === "first" ||
					prop === "raw"
				) {
					const fn = target[prop] as (...a: unknown[]) => Promise<unknown>;
					return async (...args: unknown[]) => {
						trip(query);
						return fn.apply(target, args);
					};
				}
				return bound(target, prop);
			},
		});
		real.set(proxy, stmt);
		sqlOf.set(proxy, query);
		return proxy;
	};
	return new Proxy(db, {
		get(target, prop) {
			if (prop === "prepare") {
				return (query: string) => wrap(target.prepare(query), query);
			}
			if (prop === "batch") {
				return async (stmts: D1PreparedStatement[]) => {
					for (const s of stmts) trip(sqlOf.get(s) ?? "");
					return target.batch(stmts.map((s) => real.get(s) ?? s));
				};
			}
			return bound(target, prop);
		},
	});
}

/** Matches the method name: "send" or "sendBatch". */
export function faultyQueue<T>(queue: Queue<T>, rules: FaultRule[]): Queue<T> {
	const trip = tripwire(rules, "Queue error");
	return new Proxy(queue, {
		get(target, prop) {
			if (prop === "send" || prop === "sendBatch") {
				const fn = bound(target, prop);
				return async (...args: unknown[]) => {
					trip(prop);
					return fn(...args);
				};
			}
			return bound(target, prop);
		},
	});
}

/** Matches "<method> <key>" for put/get/head/delete; every call is logged. */
export function faultyR2(
	bucket: R2Bucket,
	rules: FaultRule[] = [],
): R2Bucket & { log: string[] } {
	const trip = tripwire(rules, "R2 error");
	const log: string[] = [];
	return new Proxy(bucket, {
		get(target, prop) {
			if (prop === "log") return log;
			if (
				prop === "put" ||
				prop === "get" ||
				prop === "head" ||
				prop === "delete"
			) {
				const fn = bound(target, prop);
				return async (key: string, ...rest: unknown[]) => {
					const text = `${prop} ${key}`;
					log.push(text);
					trip(text);
					return fn(key, ...rest);
				};
			}
			return bound(target, prop);
		},
	}) as R2Bucket & { log: string[] };
}

/** Deps whose bindings fail per the rules; everything else is `base`. */
export function faultyDeps(
	base: Deps,
	f: { d1?: FaultRule[]; queue?: FaultRule[]; r2?: FaultRule[] },
): Deps & { r2Log: string[] } {
	const payloads = faultyR2(base.payloads, f.r2 ?? []);
	return {
		...base,
		db: f.d1 ? drizzle(faultyD1(base.env.DB, f.d1), { schema }) : base.db,
		queue: f.queue ? faultyQueue(base.queue, f.queue) : base.queue,
		payloads,
		r2Log: payloads.log,
	};
}
