import { createFileRoute } from "@tanstack/react-router";
import { FailuresPage, failuresSearch } from "@/pages/FailuresPage";

export const Route = createFileRoute("/failures")({
	validateSearch: failuresSearch,
	component: function FailuresRoute() {
		const search = Route.useSearch();
		const navigate = Route.useNavigate();
		return (
			<FailuresPage
				search={search}
				setSearch={(s) => navigate({ search: (prev) => ({ ...prev, ...s }) })}
			/>
		);
	},
});
