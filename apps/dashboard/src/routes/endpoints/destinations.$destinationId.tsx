import { createFileRoute } from "@tanstack/react-router";
import { DestinationDetailPage } from "@/pages/endpoints/DestinationDetailPage";

export const Route = createFileRoute("/endpoints/destinations/$destinationId")({
	component: function DestinationRoute() {
		const { destinationId } = Route.useParams();
		return (
			<DestinationDetailPage
				key={destinationId}
				destinationId={destinationId}
			/>
		);
	},
});
