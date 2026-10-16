import { createFileRoute } from "@tanstack/react-router";
import { ArchivesPage, archivesSearch } from "@/pages/ArchivesPage";

export const Route = createFileRoute("/archives")({
	validateSearch: archivesSearch,
	component: function ArchivesRoute() {
		const search = Route.useSearch();
		return <ArchivesPage search={search} />;
	},
});
