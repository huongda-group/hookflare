import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { invalidateDeliveryViews } from "./invalidate-delivery-views";
import { qk } from "./keys";

function setup() {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return { qc, wrapper };
}

describe("invalidateDeliveryViews", () => {
	it("invalidates the submitted project even when its queries are inactive", async () => {
		const { qc } = setup();
		const keys = (projectId: string) => [
			qk.events.one("evt_1", projectId),
			qk.events.list({ project_id: projectId }),
			qk.failures.list({ project_id: projectId }),
			qk.overview({ project_id: projectId }),
			qk.destinations.stats({ project_id: projectId }),
		];
		const a = keys("prj_a");
		const b = keys("prj_b");
		for (const key of [...a, ...b]) qc.setQueryData(key, { data: [] });
		await invalidateDeliveryViews(qc, "prj_a");
		for (const key of a)
			expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
		for (const key of b)
			expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
	});

	it("refetches the events, failures, overview, and destination-stats prefixes", async () => {
		const { qc, wrapper } = setup();
		const fetches = { events: 0, failures: 0, overview: 0, stats: 0 };
		const page = { data: [] as unknown[], next_cursor: null };
		renderHook(
			() =>
				useQuery({
					queryKey: qk.events.list({ status: ["dead"] }),
					queryFn: async () => {
						fetches.events += 1;
						return page;
					},
				}),
			{ wrapper },
		);
		renderHook(
			() =>
				useQuery({
					queryKey: qk.failures.list({ status: ["dead"] }),
					queryFn: async () => {
						fetches.failures += 1;
						return page;
					},
				}),
			{ wrapper },
		);
		renderHook(
			() =>
				useQuery({
					queryKey: qk.overview({ range: "24h" }),
					queryFn: async () => {
						fetches.overview += 1;
						return { events: 0 };
					},
				}),
			{ wrapper },
		);
		renderHook(
			() =>
				useQuery({
					queryKey: qk.destinations.stats({ project_id: "prj_1" }),
					queryFn: async () => {
						fetches.stats += 1;
						return page;
					},
				}),
			{ wrapper },
		);
		await waitFor(() =>
			expect(fetches).toEqual({
				events: 1,
				failures: 1,
				overview: 1,
				stats: 1,
			}),
		);

		await invalidateDeliveryViews(qc);

		await waitFor(() =>
			expect(fetches).toEqual({
				events: 2,
				failures: 2,
				overview: 2,
				stats: 2,
			}),
		);
	});
});
