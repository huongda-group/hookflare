import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { destination, source, T } from "../../helpers/fixtures";
import { renderApp } from "../../helpers/render";
import { apiUrl, server } from "../../helpers/server";

const PATH = "/endpoints/sources/src_1";

describe("Source detail", () => {
	it("shows the config, auth settings, and fingerprint", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () => HttpResponse.json(source())),
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({ data: [destination()], next_cursor: null }),
			),
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
		expect(
			await screen.findByRole("link", { name: "Billing API" }),
		).toHaveAttribute("href", "/endpoints/destinations/dst_1?project_id=prj_1");
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

	it("names the target destination and links the scoped event stream", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () => HttpResponse.json(source())),
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({ data: [destination()], next_cursor: null }),
			),
		);
		renderApp(PATH);
		expect(
			await screen.findByRole("link", { name: "Billing API" }),
		).toHaveAttribute("href", "/endpoints/destinations/dst_1?project_id=prj_1");
		const stream = screen
			.getByText("Scoped events")
			.closest("div") as HTMLElement;
		const events = within(stream).getByRole("link", { name: /view events/i });
		expect(events.getAttribute("href")).toContain("project_id=prj_1");
		expect(events.getAttribute("href")).toContain("source_id=src_1");
	});

	it("offers a copy button for the public ingress URL", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () => HttpResponse.json(source())),
		);
		renderApp(PATH);
		await screen.findByRole("heading", { name: "Stripe" });
		const field = screen.getByText("Ingress URL").closest("div") as HTMLElement;
		expect(
			within(field).getByRole("button", {
				name: /copy/i,
			}),
		).toBeInTheDocument();
	});

	it("offers Retry when the source fails to load", async () => {
		let reads = 0;
		server.use(
			http.get(apiUrl("/sources/src_1"), () => {
				reads += 1;
				return reads === 1
					? HttpResponse.json({ error: "internal" }, { status: 500 })
					: HttpResponse.json(source());
			}),
		);
		const { user } = renderApp(PATH);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/could not load the source/i);
		await user.click(within(alert).getByRole("button", { name: "Retry" }));
		expect(
			await screen.findByRole("heading", { name: "Stripe" }),
		).toBeInTheDocument();
		expect(reads).toBe(2);
	});

	it("shows the body limit, event ID selector, and unlabelled auth settings", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () =>
				HttpResponse.json(
					source({
						max_body_bytes: 1024,
						event_id_from: "json_path",
						event_id_selector: "$.id",
						auth_config: {
							header: "Stripe-Signature",
							algorithm: "sha256",
							encoding: "hex",
							tolerance: 300,
						} as ReturnType<typeof source>["auth_config"],
					}),
				),
			),
		);
		renderApp(PATH);
		await screen.findByRole("heading", { name: "Stripe" });
		const field = (label: string) =>
			screen.getByText(label).closest("div") as HTMLElement;
		expect(
			within(field("Max body size")).getByText("1024 bytes"),
		).toBeInTheDocument();
		expect(within(field("Selector")).getByText("$.id")).toBeInTheDocument();
		expect(within(field("tolerance")).getByText("300")).toBeInTheDocument();
	});

	it("says so when the API reports no stored secret", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () =>
				HttpResponse.json(source({ secret_fingerprint: null })),
			),
		);
		renderApp(PATH);
		const field = (await screen.findByText("Secret fingerprint")).closest(
			"div",
		) as HTMLElement;
		expect(within(field).getByText("No secret")).toBeInTheDocument();
	});
});
