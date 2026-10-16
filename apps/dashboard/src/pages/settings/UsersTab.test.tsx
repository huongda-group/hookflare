import { screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";

describe("Settings › Users", () => {
	it("badges service-token identities", async () => {
		server.use(
			http.get(apiUrl("/users"), () =>
				HttpResponse.json({
					data: [
						{
							email: "svc:ab.access",
							role: "operator",
							created_at: 1,
							updated_at: 1,
							disabled_at: null,
						},
					],
					next_cursor: null,
				}),
			),
		);
		renderApp("/settings?tab=users");
		expect(await screen.findByText("svc:ab.access")).toBeInTheDocument();
		expect(await screen.findByText("Service token")).toBeInTheDocument();
	});
});
