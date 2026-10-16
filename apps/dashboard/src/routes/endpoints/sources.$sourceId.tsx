import { createFileRoute } from "@tanstack/react-router";
import { SourceDetailPage } from "@/pages/endpoints/SourceDetailPage";

export const Route = createFileRoute("/endpoints/sources/$sourceId")({
	component: function SourceRoute() {
		const { sourceId } = Route.useParams();
		return <SourceDetailPage key={sourceId} sourceId={sourceId} />;
	},
});
