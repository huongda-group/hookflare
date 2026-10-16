import { createFileRoute } from "@tanstack/react-router";
import { AlertDetailPage } from "@/pages/AlertDetailPage";

export const Route = createFileRoute("/alerts/$alertId")({
	component: function AlertDetailRoute() {
		const { alertId } = Route.useParams();
		return <AlertDetailPage key={alertId} alertId={alertId} />;
	},
});
