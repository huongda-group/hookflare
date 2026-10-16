import { createFileRoute } from "@tanstack/react-router";
import { EventsPage, eventsSearch } from "@/pages/EventsPage";

export const Route = createFileRoute("/events/")({
	validateSearch: eventsSearch,
	component: function EventsRoute() {
		const search = Route.useSearch();
		const navigate = Route.useNavigate();
		return (
			<EventsPage
				search={search}
				setSearch={(s) => navigate({ search: (prev) => ({ ...prev, ...s }) })}
			/>
		);
	},
});
