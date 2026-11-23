import { createFileRoute } from "@tanstack/react-router";
import { projectDetailSearch, useActiveProject } from "@/lib/project-selection";
import { SourceDetailPage } from "@/pages/endpoints/SourceDetailPage";

export const Route = createFileRoute("/endpoints/sources/$sourceId")({
	staticData: { pageTitle: "Source details" },
	validateSearch: projectDetailSearch,
	component: function SourceRoute() {
		const { sourceId } = Route.useParams();
		const { projectId } = useActiveProject();
		return projectId ? (
			<SourceDetailPage
				key={sourceId}
				sourceId={sourceId}
				projectId={projectId}
			/>
		) : /* istanbul ignore next -- @preserve */ null;
	},
});
