import { screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { source, T } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

const PATH = "/endpoints/sources/src_1";

describe("Source detail", () => {
	it("shows the config, auth settings, and fingerprint", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () => HttpResponse.json(source())),
		);
		renderApp(PATH);
		expect(
			await screen.findByRole("heading", { name: "Stripe" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("https://hooks.example.com/in/src_1"),
		).toBeInTheDocument();
		expect(screen.getByText("Stripe-Signature")).toBeInTheDocument();
		expect(screen.getByText("ef56ab78")).toBeInTheDocument();
		expect(screen.queryByText(/previous secret/i)).not.toBeInTheDocument();
		expect(screen.getByRole("link", { name: "dst_1" })).toHaveAttribute(
			"href",
			"/endpoints/destinations/dst_1",
		);
	});

	it("shows the grace window when a previous secret is still valid", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () =>
				HttpResponse.json(
					source({
						previous_secret_fingerprint: "11223344",
						previous_secret_expires_at: T + 3_600_000,
					}),
				),
			),
		);
		renderApp(PATH);
		expect(await screen.findByText("11223344")).toBeInTheDocument();
		expect(
			screen.getByText(/previous secret valid until/i),
		).toBeInTheDocument();
	});

	it("shows a not-found state on 404", async () => {
		server.use(
			http.get(apiUrl("/sources/src_x"), () =>
				HttpResponse.json({ error: "not_found" }, { status: 404 }),
			),
		);
		renderApp("/endpoints/sources/src_x");
		expect(
			await screen.findByText(/source src_x was not found/i),
		).toBeInTheDocument();
	});
});
