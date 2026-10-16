import { createFileRoute } from "@tanstack/react-router";
import { AlertsPage, alertsSearch } from "@/pages/AlertsPage";

export const Route = createFileRoute("/alerts/")({
	validateSearch: alertsSearch,
	component: function AlertsRoute() {
		const search = Route.useSearch();
		const navigate = Route.useNavigate();
		return (
			<AlertsPage
				search={search}
				setSearch={(s) => navigate({ search: (prev) => ({ ...prev, ...s }) })}
			/>
		);
	},
});
