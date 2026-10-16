import type { StatsRange } from "@hookflare/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { IdText } from "@/components/IdText";
import { ProjectFormDialog } from "@/components/ProjectFormDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { Can } from "@/lib/permissions";
import { qk } from "@/lib/queries/keys";
import { useProject } from "@/lib/queries/projects";
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
	const [editing, setEditing] = useState(false);
	const [toggling, setToggling] = useState(false);
	if (!project.data) return <p className="text-neutral-500">Loading…</p>;
	const p = project.data;
	const next = p.status === "active" ? "disabled" : "active";
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3">
				<h1 className="text-xl font-semibold">{p.name}</h1>
				<StatusBadge status={p.status} />
				<IdText id={p.id} />
				<div className="ml-auto flex gap-2">
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
				</div>
			</div>
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
				}}
			/>
		</div>
	);
}
