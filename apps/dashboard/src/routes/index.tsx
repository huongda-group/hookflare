import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage, overviewSearch } from "@/pages/OverviewPage";

export const Route = createFileRoute("/")({
	validateSearch: overviewSearch,
	component: function OverviewRoute() {
		const search = Route.useSearch();
		const navigate = Route.useNavigate();
		return (
			<OverviewPage
				search={search}
				setSearch={(s) => navigate({ search: (prev) => ({ ...prev, ...s }) })}
			/>
		);
	},
});
