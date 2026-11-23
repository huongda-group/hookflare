import { createFileRoute } from "@tanstack/react-router";
import { projectDetailSearch, useActiveProject } from "@/lib/project-selection";
import { DestinationDetailPage } from "@/pages/endpoints/DestinationDetailPage";

export const Route = createFileRoute("/endpoints/destinations/$destinationId")({
	staticData: { pageTitle: "Destination details" },
	validateSearch: projectDetailSearch,
	component: function DestinationRoute() {
		const { destinationId } = Route.useParams();
		const { projectId } = useActiveProject();
		return projectId ? (
			<DestinationDetailPage
				key={destinationId}
				destinationId={destinationId}
				projectId={projectId}
			/>
		) : /* istanbul ignore next -- @preserve unreachable: AppShell renders project-scoped outlets only once a project is active */ null;
	},
});
