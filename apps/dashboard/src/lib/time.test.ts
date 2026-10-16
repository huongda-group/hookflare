import { describe, expect, it } from "vitest";
import { formatBytes, formatRelative, groupByDay } from "./time";

const H = 3_600_000;
// 2026-10-15T17:00Z is local midnight of Oct 16 in Asia/Ho_Chi_Minh (UTC+7).
const MIDNIGHT = Date.UTC(2026, 9, 15, 17);

describe("time", () => {
	it("groups hourly points into local days", () => {
		const points = [-2, -1, 0, 1, 23, 24].map((i) => ({
			hour: MIDNIGHT + i * H,
			received: 1,
			delivered: 1,
			failed: 0,
		}));
		expect(groupByDay(points)).toEqual([
			{ hour: MIDNIGHT - 24 * H, received: 2, delivered: 2, failed: 0 },
			{ hour: MIDNIGHT, received: 3, delivered: 3, failed: 0 },
			{ hour: MIDNIGHT + 24 * H, received: 1, delivered: 1, failed: 0 },
		]);
	});

	it("formats relative times", () => {
		expect(formatRelative(1_000_000 - 30_000, 1_000_000)).toBe("30 sec. ago");
		expect(formatRelative(1_000_000 - 3 * 60_000, 1_000_000)).toBe(
			"3 min. ago",
		);
		expect(formatRelative(1_000_000 + 2 * H, 1_000_000)).toBe("in 2 hr.");
	});

	it("formats byte sizes", () => {
		expect(formatBytes(17)).toBe("17 B");
		expect(formatBytes(65_536)).toBe("64.0 KB");
		expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
	});
});
