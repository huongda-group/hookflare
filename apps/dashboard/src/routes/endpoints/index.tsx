import { createFileRoute } from "@tanstack/react-router";
import { EndpointsPage, endpointsSearch } from "@/pages/EndpointsPage";

export const Route = createFileRoute("/endpoints/")({
	validateSearch: endpointsSearch,
	component: function EndpointsRoute() {
		const search = Route.useSearch();
		const navigate = Route.useNavigate();
		return (
			<EndpointsPage
				search={search}
				setSearch={(s) => navigate({ search: (prev) => ({ ...prev, ...s }) })}
			/>
		);
	},
});
