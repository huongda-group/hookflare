import { createFileRoute } from "@tanstack/react-router";
import { projectDetailSearch, useActiveProject } from "@/lib/project-selection";
import { EventDetailPage } from "@/pages/EventDetailPage";

export const Route = createFileRoute("/events/$eventId")({
	staticData: { pageTitle: "Event details" },
	validateSearch: projectDetailSearch,
	component: function EventRoute() {
		const { eventId } = Route.useParams();
		const { projectId } = useActiveProject();
		return projectId ? (
			<EventDetailPage key={eventId} eventId={eventId} projectId={projectId} />
		) : null;
	},
});
