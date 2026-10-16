import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { createAppRouter, createQueryClient } from "./router";

it("renders the root route", async () => {
	const qc = createQueryClient();
	const router = createAppRouter(
		qc,
		createMemoryHistory({ initialEntries: ["/"] }),
	);
	render(
		<QueryClientProvider client={qc}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	expect(await screen.findByText("Hookflare")).toBeInTheDocument();
});
