import { createFileRoute, useLocation } from "@tanstack/react-router";
import { z } from "zod";
import {
	alertLinkScope,
	projectDetailSearch,
	useActiveProject,
} from "@/lib/project-selection";
import { AlertDetailPage } from "@/pages/AlertDetailPage";

export const Route = createFileRoute("/alerts/$alertId")({
	staticData: { pageTitle: "Alert details" },
	validateSearch: projectDetailSearch.extend({
		scope: z.literal("deployment").optional().catch(undefined),
	}),
	component: function AlertDetailRoute() {
		const { alertId } = Route.useParams();
		const search = useLocation({ select: (location) => location.searchStr });
		const mode = alertLinkScope(new URLSearchParams(search));
		const { projectId } = useActiveProject();
		if (mode === "legacy")
			return <AlertDetailPage key={`${alertId}:legacy`} alertId={alertId} />;
		if (mode === "deployment")
			return (
				<AlertDetailPage
					key={`${alertId}:deployment`}
					alertId={alertId}
					scope={{ scope: "deployment" }}
				/>
			);
		return projectId ? (
			<AlertDetailPage
				key={alertId}
				alertId={alertId}
				scope={{ project_id: projectId }}
			/>
		) : /* istanbul ignore next -- @preserve unreachable: AppShell renders project-scoped outlets only once a project is active */ null;
	},
});
