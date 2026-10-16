import { STATS_RANGES } from "@hookflare/shared";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

export const Route = createFileRoute("/projects/$projectId")({
	validateSearch: z.object({
		range: z.enum(STATS_RANGES).default("24h").catch("24h"),
	}),
	component: function ProjectRoute() {
		const { projectId } = Route.useParams();
		const { range } = Route.useSearch();
		const navigate = Route.useNavigate();
		return (
			<ProjectDetailPage
				projectId={projectId}
				range={range}
				setRange={(r) => navigate({ search: { range: r } })}
			/>
		);
	},
});
