import { createFileRoute } from "@tanstack/react-router";
import { useActiveProject } from "@/lib/project-selection";
import { AlertsPage, alertsSearch } from "@/pages/AlertsPage";

export const Route = createFileRoute("/alerts/")({
	staticData: { pageTitle: "Alerts" },
	validateSearch: alertsSearch,
	component: function AlertsRoute() {
		const search = Route.useSearch();
		const navigate = Route.useNavigate();
		const { projectId } = useActiveProject();
		return projectId ? (
			<AlertsPage
				projectId={projectId}
				search={search}
				setSearch={(s) => navigate({ search: (prev) => ({ ...prev, ...s }) })}
			/>
		) : /* istanbul ignore next -- @preserve unreachable: AppShell renders project-scoped outlets only once a project is active */ null;
	},
});
