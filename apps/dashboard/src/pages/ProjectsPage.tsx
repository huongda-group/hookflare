import type { Project } from "@hookflare/shared";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CursorTable } from "@/components/CursorTable";
import { IdText } from "@/components/IdText";
import { ProjectFormDialog } from "@/components/ProjectFormDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeText } from "@/components/TimeText";
import { Button } from "@/components/ui/button";
import { Can } from "@/lib/permissions";
import { useProjectsPage } from "@/lib/queries/projects";

export function ProjectsPage() {
	const query = useProjectsPage();
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold">Projects</h1>
				<Can permission="config.write">
					<Button onClick={() => setCreating(true)}>New project</Button>
				</Can>
			</div>
			<CursorTable<Project>
				query={query}
				rowKey={(p) => p.id}
				empty="No projects yet."
				onRowClick={(p) =>
					void navigate({
						to: "/projects/$projectId",
						params: { projectId: p.id },
					})
				}
				columns={[
					{ header: "Name", cell: (p) => p.name },
					{
						header: "Slug",
						cell: (p) => <span className="font-mono text-xs">{p.slug}</span>,
					},
					{ header: "ID", cell: (p) => <IdText id={p.id} /> },
					{ header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
					{ header: "Created", cell: (p) => <TimeText ms={p.created_at} /> },
				]}
			/>
			<ProjectFormDialog open={creating} onOpenChange={setCreating} />
		</div>
	);
}
