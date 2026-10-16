import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage, settingsSearch } from "@/pages/SettingsPage";

export const Route = createFileRoute("/settings")({
	validateSearch: settingsSearch,
	component: function SettingsRoute() {
		const search = Route.useSearch();
		const navigate = Route.useNavigate();
		return (
			<SettingsPage
				search={search}
				setSearch={(s) => navigate({ search: s })}
			/>
		);
	},
});
