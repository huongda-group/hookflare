import { createFileRoute } from "@tanstack/react-router";
import { useActiveProject } from "@/lib/project-selection";
import { FailuresPage, failuresSearch } from "@/pages/FailuresPage";

export const Route = createFileRoute("/failures")({
	staticData: { pageTitle: "Failures" },
	validateSearch: failuresSearch,
	component: function FailuresRoute() {
		const search = Route.useSearch();
		const navigate = Route.useNavigate();
		const { projectId } = useActiveProject();
		return projectId ? (
			<FailuresPage
				projectId={projectId}
				search={search}
				setSearch={(s) => navigate({ search: (prev) => ({ ...prev, ...s }) })}
			/>
		) : /* istanbul ignore next -- @preserve unreachable: AppShell renders project-scoped outlets only once a project is active */ null;
	},
});
