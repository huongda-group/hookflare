import type { TrendPoint } from "@hookflare/shared";

const rtf = new Intl.RelativeTimeFormat("en", {
	numeric: "always",
	style: "short",
});
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["day", 86_400_000],
	["hour", 3_600_000],
	["minute", 60_000],
	["second", 1000],
];

export function formatRelative(ms: number, now = Date.now()): string {
	const diff = ms - now;
	for (const [unit, size] of UNITS) {
		if (Math.abs(diff) >= size || unit === "second")
			return rtf.format(Math.round(diff / size), unit);
	}
	return "";
}

export const formatAbsolute = (ms: number) =>
	new Date(ms).toLocaleString("en-GB", {
		dateStyle: "medium",
		timeStyle: "medium",
	});
export const formatIso = (ms: number) => new Date(ms).toISOString();

function localMidnight(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** Spec M4-7: the server sends hours; days are the browser's local days. */
export function groupByDay(points: TrendPoint[]): TrendPoint[] {
	const days = new Map<number, TrendPoint>();
	for (const p of points) {
		const day = localMidnight(p.hour);
		const acc = days.get(day) ?? {
			hour: day,
			received: 0,
			delivered: 0,
			failed: 0,
		};
		acc.received += p.received;
		acc.delivered += p.delivered;
		acc.failed += p.failed;
		days.set(day, acc);
	}
	return [...days.values()].sort((a, b) => a.hour - b.hour);
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** `datetime-local` wants local "YYYY-MM-DDTHH:mm". */
export function toLocalInput(ms: number) {
	const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
	return d.toISOString().slice(0, 16);
}

/** Parses a `datetime-local` value as local time; empty means no bound. */
export const fromLocalInput = (v: string) =>
	v ? new Date(v).getTime() : undefined;
