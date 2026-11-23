import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { EventDeliveryContext } from "@/components/EventDeliveryContext";
import { createQueryClient } from "@/router";
import {
	delivery,
	destination,
	source,
	webhookEvent,
} from "../helpers/fixtures";
import { apiUrl, server } from "../helpers/server";

const renderContext = (ui: React.ReactElement) =>
	render(
		<QueryClientProvider client={createQueryClient()}>
			{ui}
		</QueryClientProvider>,
	);

describe("EventDeliveryContext", () => {
	it("names the source, destination, and outcome of the selected delivery", async () => {
		server.use(
			http.get(apiUrl("/sources/src_1"), () => HttpResponse.json(source())),
			http.get(apiUrl("/destinations/dst_1"), () =>
				HttpResponse.json(destination()),
			),
		);
		renderContext(
			<EventDeliveryContext event={webhookEvent()} delivery={delivery()} />,
		);
		const region = screen.getByRole("region", {
			name: "Event delivery context",
		});
		expect(await within(region).findByText("Stripe")).toBeInTheDocument();
		expect(await within(region).findByText("Billing API")).toBeInTheDocument();
		expect(within(region).getByText("Dead letter")).toBeInTheDocument();
	});

	it("says so when the source is unknown and nothing was delivered yet", () => {
		renderContext(
			<EventDeliveryContext
				event={webhookEvent({ source_id: "", deliveries: [] })}
				delivery={null}
			/>,
		);
		expect(screen.getByText("Unknown source")).toBeInTheDocument();
		expect(screen.getByText("No delivery destination")).toBeInTheDocument();
		expect(screen.getByText("No deliveries yet")).toBeInTheDocument();
	});
});
