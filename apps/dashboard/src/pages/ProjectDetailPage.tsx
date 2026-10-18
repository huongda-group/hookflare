import type { StatsRange } from "@hookflare/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { IdText } from "@/components/IdText";
import { PageHeader } from "@/components/PageHeader";
import { ProjectFormDialog } from "@/components/ProjectFormDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { invalidateDeliveryViews } from "@/lib/queries/invalidate-delivery-views";
import { Can } from "@/lib/permissions";
import { qk } from "@/lib/queries/keys";
import { useProject } from "@/lib/queries/projects";
import { useDestinationsPage, useSourcesPage } from "@/lib/queries/endpoints";
import { OverviewContent } from "./OverviewPage";

export function ProjectDetailPage({
	projectId,
	range,
	setRange,
}: {
	projectId: string;
	range: StatsRange;
	setRange: (r: StatsRange) => void;
}) {
	const qc = useQueryClient();
	const project = useProject(projectId);
	const sources = useSourcesPage({ project_id: projectId });
	const destinations = useDestinationsPage({ project_id: projectId });
	const [editing, setEditing] = useState(false);
	const [toggling, setToggling] = useState(false);
	if (!project.data)
		return <p className="p-6 text-muted-foreground">Loading…</p>;
	const p = project.data;
	const next = p.status === "active" ? "disabled" : "active";
	const sourcesEmpty =
		sources.data !== undefined &&
		sources.data.pages.every((page) => page.data.length === 0);
	const destinationsEmpty =
		destinations.data !== undefined &&
		destinations.data.pages.every((page) => page.data.length === 0);
	return (
		<div className="space-y-6">
			<Link
				to="/projects"
				className="text-sm text-muted-foreground underline hover:text-foreground"
			>
				Back to projects
			</Link>
			<PageHeader
				title={p.name}
				description={
					<span className="flex flex-wrap items-center gap-3">
						<StatusBadge status={p.status} />
						<IdText id={p.id} />
					</span>
				}
				actions={
					<Can permission="config.write">
						<Button variant="outline" onClick={() => setEditing(true)}>
							Edit
						</Button>
						<Button
							variant={next === "disabled" ? "destructive" : "outline"}
							onClick={() => setToggling(true)}
						>
							{next === "disabled" ? "Disable" : "Enable"}
						</Button>
					</Can>
				}
			>
				<nav aria-label="Project resources" className="flex flex-wrap gap-2">
					<Button variant="outline" size="sm" asChild>
						<Link
							to="/endpoints"
							search={{ tab: "sources", project_id: projectId }}
						>
							Sources
						</Link>
					</Button>
					<Button variant="outline" size="sm" asChild>
						<Link
							to="/endpoints"
							search={{ tab: "destinations", project_id: projectId }}
						>
							Destinations
						</Link>
					</Button>
					<Button variant="outline" size="sm" asChild>
						<Link to="/events" search={{ project_id: projectId }}>
							Events
						</Link>
					</Button>
				</nav>
			</PageHeader>
			{sourcesEmpty && destinationsEmpty ? (
				<div className="rounded-lg border border-border bg-card p-6">
					<h2 className="text-[15px] leading-snug font-medium text-foreground">
						No sources or destinations yet
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						Add a source to accept events, then a destination to receive
						deliveries.
					</p>
					<Can permission="config.write">
						<div className="mt-4 flex flex-wrap gap-2">
							<Button size="sm" asChild>
								<Link
									to="/endpoints"
									search={{ tab: "sources", project_id: projectId }}
								>
									New source
								</Link>
							</Button>
							<Button size="sm" variant="outline" asChild>
								<Link
									to="/endpoints"
									search={{ tab: "destinations", project_id: projectId }}
								>
									New destination
								</Link>
							</Button>
						</div>
					</Can>
				</div>
			) : null}
			<OverviewContent
				projectId={projectId}
				range={range}
				onRangeChange={setRange}
			/>
			<ProjectFormDialog open={editing} onOpenChange={setEditing} project={p} />
			<ConfirmDialog
				open={toggling}
				onOpenChange={setToggling}
				title={`${next === "disabled" ? "Disable" : "Enable"} ${p.name}?`}
				description={
					next === "disabled"
						? "Ingress for this project's sources stops accepting events."
						: "Sources accept events again."
				}
				confirmLabel={next === "disabled" ? "Disable" : "Enable"}
				destructive={next === "disabled"}
				onConfirm={async (reason) => {
					await api.patch(`/projects/${p.id}`, { status: next, reason });
					await qc.invalidateQueries({ queryKey: qk.projects.all });
					await invalidateDeliveryViews(qc);
				}}
			/>
		</div>
	);
}
