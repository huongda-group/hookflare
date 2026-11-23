import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEvent } from "@/lib/queries/events";
import { createQueryClient } from "@/router";
import { delivery, webhookEvent } from "../../helpers/fixtures";
import { apiUrl, server } from "../../helpers/server";

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={createQueryClient()}>
			{children}
		</QueryClientProvider>
	);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("useEvent polling", () => {
	it.each([
		["refetches every 15 s while a delivery can still change", "retrying", 2],
		["stops polling once every delivery is terminal", "delivered", 1],
	] as const)("%s", async (_label, status, expected) => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let calls = 0;
		server.use(
			http.get(apiUrl("/events/evt_1"), () => {
				calls += 1;
				return HttpResponse.json(
					webhookEvent({ deliveries: [delivery({ status })] }),
				);
			}),
		);
		const { result } = renderHook(() => useEvent("evt_1", "prj_1"), {
			wrapper,
		});
		await waitFor(() => expect(result.current.data).toBeDefined());
		expect(calls).toBe(1);

		await vi.advanceTimersByTimeAsync(15_000);
		await waitFor(() => expect(calls).toBe(expected));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls).toBe(expected);
	});
});
