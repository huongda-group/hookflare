import { QueryObserver } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { ApiError, api, PERMISSION_DENIED_MESSAGE } from "@/lib/api";
import { qk } from "@/lib/queries/keys";
import { createQueryClient } from "@/router";
import { renderApp } from "../helpers/render";
import { apiUrl, meFor, server } from "../helpers/server";

const forbidden = () =>
	Promise.reject(new ApiError(403, "forbidden", undefined, "events.read"));

describe("root route guard", () => {
	it("sends /setup to the login page once setup is complete", async () => {
		const { router } = renderApp("/setup");
		expect(
			await screen.findByRole("button", { name: "Sign in" }),
		).toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/login");
	});
});

describe("query client 403 handling", () => {
	it("reloads /me and announces the denial when another query is forbidden", async () => {
		const announce = vi.spyOn(toast, "error");
		try {
			const client = createQueryClient();
			client.setQueryData(qk.me, meFor("admin"));
			await client
				.fetchQuery({ queryKey: ["probe"], queryFn: forbidden })
				.catch(() => {});
			expect(client.getQueryState(qk.me)?.isInvalidated).toBe(true);
			expect(announce).toHaveBeenCalledWith(PERMISSION_DENIED_MESSAGE);
		} finally {
			announce.mockRestore();
		}
	});

	it("does not refetch /me in a loop when /me itself is forbidden", async () => {
		const announce = vi.spyOn(toast, "error");
		let meLoads = 0;
		server.use(
			http.get(apiUrl("/me"), () => {
				meLoads++;
				return HttpResponse.json({ error: "forbidden" }, { status: 403 });
			}),
		);
		const client = createQueryClient();
		// An active observer, as AppShell has: an invalidation would refetch it.
		const observer = new QueryObserver(client, {
			queryKey: qk.me,
			queryFn: () => api.get("/me"),
		});
		const unsubscribe = observer.subscribe(() => {});
		try {
			await waitFor(() =>
				expect(observer.getCurrentResult().isError).toBe(true),
			);
			await waitFor(() => expect(client.isFetching()).toBe(0));
			expect(meLoads).toBe(1);
			expect(announce).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
			announce.mockRestore();
		}
	});

	it("reloads /me without a duplicate toast when a write is forbidden", async () => {
		const announce = vi.spyOn(toast, "error");
		try {
			const client = createQueryClient();
			client.setQueryData(qk.me, meFor("admin"));
			await client
				.getMutationCache()
				.build(client, { mutationFn: forbidden })
				.execute(undefined)
				.catch(() => {});
			await waitFor(() =>
				expect(client.getQueryState(qk.me)?.isInvalidated).toBe(true),
			);
			expect(announce).not.toHaveBeenCalled();
		} finally {
			announce.mockRestore();
		}
	});
});
