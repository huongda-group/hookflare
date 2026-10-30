import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrendChart } from "./TrendChart";

describe("TrendChart", () => {
	it("labels local daily buckets with their local date east of UTC", () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = "Asia/Ho_Chi_Minh";
		try {
			// Oct 15 17:00Z is Oct 16 midnight in Asia/Ho_Chi_Minh.
			render(
				<TrendChart
					range="7d"
					points={[
						{
							hour: Date.UTC(2026, 9, 15, 16),
							received: 1,
							delivered: 1,
							failed: 0,
						},
						{
							hour: Date.UTC(2026, 9, 15, 17),
							received: 2,
							delivered: 2,
							failed: 0,
						},
						{
							hour: Date.UTC(2026, 9, 15, 18),
							received: 3,
							delivered: 3,
							failed: 0,
						},
					]}
				/>,
			);
			const rows = within(
				screen.getByRole("table", { name: "Traffic trend" }),
			).getAllByRole("row");
			expect(rows).toHaveLength(3);
			expect(
				within(rows[1])
					.getAllByRole("cell")
					.map((cell) => cell.textContent),
			).toEqual(["15 Oct", "1", "1", "0"]);
			expect(
				within(rows[2])
					.getAllByRole("cell")
					.map((cell) => cell.textContent),
			).toEqual(["16 Oct", "5", "5", "0"]);
			expect(screen.getByText(/Daily traffic rollups/)).toHaveTextContent(
				"local time",
			);
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});
});
