import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createQueryClient } from "@/router";
import { destination, project, source } from "@/test/fixtures";
import { apiUrl, server } from "@/test/server";
import { qk } from "./keys";
import { useResourceOptions } from "./resource-options";

function harness() {
	const client = createQueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { client, wrapper };
}

/** Records every option-list request's query string. */
function record(path: string, pages: Record<string, unknown>[]) {
	const calls: URLSearchParams[] = [];
	server.use(
		http.get(apiUrl(path), ({ request }) => {
			const params = new URL(request.url).searchParams;
			calls.push(params);
			const cursor = params.get("cursor");
			const page = pages[Number(cursor ?? 0)];
			return HttpResponse.json(page ?? { data: [], next_cursor: null });
		}),
	);
	return calls;
}

describe("useResourceOptions", () => {
	it("maps options and follows next_cursor with limit 50", async () => {
		const calls = record("/projects", [
			{
				data: [project({ id: "prj_1", name: "Payments" })],
				next_cursor: "1",
			},
			{
				data: [project({ id: "prj_2", name: "Ledger" })],
				next_cursor: null,
			},
		]);
		const { wrapper } = harness();
		const { result } = renderHook(() => useResourceOptions("project"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
		expect(result.current.data?.pages[0].data).toEqual([
			{ id: "prj_1", name: "Payments" },
		]);
		expect(result.current.hasNextPage).toBe(true);

		await result.current.fetchNextPage();

		await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
		expect(result.current.data?.pages[1].data).toEqual([
			{ id: "prj_2", name: "Ledger" },
		]);
		expect(result.current.hasNextPage).toBe(false);
		expect(calls).toHaveLength(2);
		expect(calls[0].get("limit")).toBe("50");
		expect(calls[0].has("cursor")).toBe(false);
		expect(calls[1].get("limit")).toBe("50");
		expect(calls[1].get("cursor")).toBe("1");
	});

	it("scopes destinations by project and keeps project_id on each option", async () => {
		const calls = record("/destinations", [
			{
				data: [destination({ id: "dst_1", name: "Billing API" })],
				next_cursor: null,
			},
		]);
		const { wrapper } = harness();
		const { result } = renderHook(
			() => useResourceOptions("destination", "prj_9"),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
		expect(result.current.data?.pages[0].data).toEqual([
			{ id: "dst_1", name: "Billing API", projectId: "prj_1" },
		]);
		expect(calls[0].get("project_id")).toBe("prj_9");
		expect(calls[0].get("limit")).toBe("50");
	});

	it("scopes sources by project", async () => {
		const calls = record("/sources", [
			{
				data: [source({ id: "src_1", name: "Stripe" })],
				next_cursor: null,
			},
		]);
		const { wrapper } = harness();
		const { result } = renderHook(() => useResourceOptions("source", "prj_7"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
		expect(result.current.data?.pages[0].data).toEqual([
			{ id: "src_1", name: "Stripe", projectId: "prj_1" },
		]);
		expect(calls[0].get("project_id")).toBe("prj_7");
	});

	it("does not send a project filter for projects", async () => {
		const calls = record("/projects", [
			{ data: [project()], next_cursor: null },
		]);
		const { wrapper } = harness();
		const { result } = renderHook(
			() => useResourceOptions("project", "prj_1"),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
		expect(calls[0].has("project_id")).toBe(false);
	});

	it("loads only the first page until the caller asks for more", async () => {
		const calls = record("/sources", [
			{
				data: [source({ id: "src_1", name: "Stripe" })],
				next_cursor: "1",
			},
			{ data: [source({ id: "src_2", name: "Ledger" })], next_cursor: null },
		]);
		const { wrapper } = harness();
		const { result } = renderHook(() => useResourceOptions("source"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
		expect(result.current.hasNextPage).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("uses query keys separate from the plain and infinite list hooks", () => {
		expect(qk.resourceOptions("project")[0]).toBe("resource-options");
		expect(qk.resourceOptions("project")).not.toEqual(qk.projects.list({}));
		expect(qk.resourceOptions("project")).not.toEqual(
			qk.projects.list({ all: true }),
		);
		expect(qk.resourceOptions("destination", "prj_1")).not.toEqual(
			qk.destinations.list({ project_id: "prj_1" }),
		);
		expect(qk.resourceOptions("source", "prj_1")).not.toEqual(
			qk.sources.list({ project_id: "prj_1" }),
		);
		expect(qk.resourceOptions("destination", "prj_1")).not.toEqual(
			qk.resourceOptions("destination", "prj_2"),
		);
	});
});

describe("keep old list hooks working", () => {
	it("retains the plain list hook shapes for other consumers", async () => {
		const calls = record("/projects", [
			{ data: [project()], next_cursor: null },
		]);
		const { useProjectsList } = await import("./projects");
		const { wrapper } = harness();
		const { result } = renderHook(() => useProjectsList(), { wrapper });

		await waitFor(() => expect(result.current.data?.data).toHaveLength(1));
		expect(result.current.data?.data[0].name).toBe("Payments");
		expect(calls[0].get("limit")).toBe("200");
	});
});
