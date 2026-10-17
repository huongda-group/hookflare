import type { Step } from "./schedule";

export type SinkSpec = {
	delay_ms?: number;
	fail_pct?: number;
};

/** A load step, optionally with its own sink behaviour. */
export type ScenarioStep = Step & { sink?: SinkSpec };

export type Scenario = {
	name: string;
	steps: ScenarioStep[];
	sources: number;
	body_bytes: number;
	sink: SinkSpec;
	drain_timeout_s: number;
	notes?: string;
};

const TOP_KEYS = new Set([
	"name",
	"steps",
	"sources",
	"body_bytes",
	"sink",
	"drain_timeout_s",
	"notes",
]);

const STEP_KEYS = new Set(["rate_per_s", "duration_s", "sink"]);

const SINK_KEYS = new Set(["delay_ms", "fail_pct"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(what: string): never {
	throw new Error(`scenario: invalid ${what}`);
}

function parseSink(raw: unknown): SinkSpec {
	if (!isRecord(raw)) fail("sink must be an object");
	for (const key of Object.keys(raw)) {
		if (!SINK_KEYS.has(key)) fail(`unknown sink key ${JSON.stringify(key)}`);
	}
	if (
		raw.delay_ms !== undefined &&
		(typeof raw.delay_ms !== "number" || !(raw.delay_ms >= 0))
	) {
		fail("sink delay_ms must be >= 0");
	}
	if (
		raw.fail_pct !== undefined &&
		(typeof raw.fail_pct !== "number" ||
			!(raw.fail_pct >= 0) ||
			!(raw.fail_pct <= 100))
	) {
		fail("sink fail_pct must be within 0..100");
	}
	return raw as SinkSpec;
}

/** The sink spec in effect for step `index`: its own, else the scenario's. */
export function stepSink(scenario: Scenario, index: number): SinkSpec {
	return scenario.steps[index]?.sink ?? scenario.sink;
}

/**
 * Parse and validate an unknown scenario document. Unknown keys are
 * rejected so typos fail loudly instead of running the wrong benchmark.
 */
export function parseScenario(raw: unknown): Scenario {
	if (!isRecord(raw)) fail("scenario must be an object");
	for (const key of Object.keys(raw)) {
		if (!TOP_KEYS.has(key)) fail(`unknown key ${JSON.stringify(key)}`);
	}
	if (typeof raw.name !== "string" || raw.name === "") fail("name");
	if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail("steps");
	const steps: ScenarioStep[] = raw.steps.map((entry) => {
		if (!isRecord(entry)) fail("step must be an object");
		for (const key of Object.keys(entry)) {
			if (!STEP_KEYS.has(key)) fail(`unknown step key ${JSON.stringify(key)}`);
		}
		if (
			typeof entry.rate_per_s !== "number" ||
			!(entry.rate_per_s > 0) ||
			!Number.isFinite(entry.rate_per_s)
		) {
			fail("step rate_per_s must be > 0");
		}
		if (
			typeof entry.duration_s !== "number" ||
			!(entry.duration_s > 0) ||
			!Number.isFinite(entry.duration_s)
		) {
			fail("step duration_s must be > 0");
		}
		return {
			rate_per_s: entry.rate_per_s,
			duration_s: entry.duration_s,
			...(entry.sink === undefined ? {} : { sink: parseSink(entry.sink) }),
		};
	});
	if (
		typeof raw.sources !== "number" ||
		!Number.isInteger(raw.sources) ||
		raw.sources < 1
	) {
		fail("sources must be an integer >= 1");
	}
	if (
		typeof raw.body_bytes !== "number" ||
		!Number.isInteger(raw.body_bytes) ||
		raw.body_bytes < 1
	) {
		fail("body_bytes must be an integer >= 1");
	}
	const sink: SinkSpec = raw.sink === undefined ? {} : parseSink(raw.sink);
	if (
		typeof raw.drain_timeout_s !== "number" ||
		!(raw.drain_timeout_s > 0) ||
		!Number.isFinite(raw.drain_timeout_s)
	) {
		fail("drain_timeout_s must be > 0");
	}
	if (
		raw.notes !== undefined &&
		(typeof raw.notes !== "string" || raw.notes === "")
	) {
		fail("notes must be a non-empty string");
	}
	return {
		name: raw.name,
		steps,
		sources: raw.sources,
		body_bytes: raw.body_bytes,
		sink,
		drain_timeout_s: raw.drain_timeout_s,
		...(raw.notes === undefined ? {} : { notes: raw.notes as string }),
	};
}
