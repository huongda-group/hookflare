import { render, screen } from "@testing-library/react";
import { cloneElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { TrendChart } from "@/components/charts/TrendChart";

vi.mock("recharts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("recharts")>();
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: ReactElement }) =>
			cloneElement(
				children as ReactElement<{ width: number; height: number }>,
				{
					width: 400,
					height: 200,
				},
			),
		Tooltip: ({
			labelFormatter,
		}: {
			labelFormatter: (v: unknown) => string;
		}) => (
			<p data-testid="tooltip-label">
				{labelFormatter(String(Date.UTC(2026, 9, 16, 3, 0)))}
			</p>
		),
	};
});

describe("TrendChart tooltip", () => {
	it("labels an hourly point with its UTC time and counts a single point", () => {
		render(
			<TrendChart
				range="24h"
				points={[
					{
						hour: Date.UTC(2026, 9, 16, 3),
						received: 4,
						delivered: 3,
						failed: 1,
					},
				]}
			/>,
		);
		expect(screen.getByTestId("tooltip-label")).toHaveTextContent("03:00");
		expect(
			screen.getByText(/Hourly traffic rollups · UTC/),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/4 events received, 3 deliveries completed, 1 failed across 1 point\./,
			),
		).toBeInTheDocument();
	});
});
