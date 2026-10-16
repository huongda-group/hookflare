import type { Role } from "@hookflare/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { createAppRouter, createQueryClient } from "@/router";
import { apiUrl, meFor, server } from "./server";

/** Renders the real route tree at `path`, signed in as `role` (default admin). */
export function renderApp(path: string, opts: { role?: Role } = {}) {
	if (opts.role) {
		const me = meFor(opts.role);
		server.use(http.get(apiUrl("/me"), () => HttpResponse.json(me)));
	}
	const queryClient = createQueryClient();
	const router = createAppRouter(
		queryClient,
		createMemoryHistory({ initialEntries: [path] }),
	);
	const user = userEvent.setup();
	render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { user, router, queryClient };
}
