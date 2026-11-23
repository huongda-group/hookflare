import { createFileRoute } from "@tanstack/react-router";
import { useActiveProject } from "@/lib/project-selection";
import { EventsPage, eventsSearch } from "@/pages/EventsPage";

export const Route = createFileRoute("/events/")({
	staticData: { pageTitle: "Events" },
	validateSearch: eventsSearch,
	component: function EventsRoute() {
		const search = Route.useSearch();
		const navigate = Route.useNavigate();
		const { projectId } = useActiveProject();
		return projectId ? (
			<EventsPage
				projectId={projectId}
				search={search}
				setSearch={(s) => navigate({ search: (prev) => ({ ...prev, ...s }) })}
			/>
		) : /* istanbul ignore next -- @preserve unreachable: AppShell renders project-scoped outlets only once a project is active */ null;
	},
});
