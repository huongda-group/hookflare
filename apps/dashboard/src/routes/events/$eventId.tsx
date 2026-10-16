import { createFileRoute } from "@tanstack/react-router";
import { EventDetailPage } from "@/pages/EventDetailPage";

export const Route = createFileRoute("/events/$eventId")({
	component: function EventRoute() {
		const { eventId } = Route.useParams();
		return <EventDetailPage key={eventId} eventId={eventId} />;
	},
});
