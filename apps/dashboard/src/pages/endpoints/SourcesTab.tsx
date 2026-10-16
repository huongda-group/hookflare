import type { Source } from "@hookflare/shared";
import { useState } from "react";
import { CursorTable } from "@/components/CursorTable";
import { IdText } from "@/components/IdText";
import { SecretRevealDialog } from "@/components/SecretRevealDialog";
import { SourceFormDialog } from "@/components/SourceFormDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Can } from "@/lib/permissions";
import { useSourcesPage } from "@/lib/queries/endpoints";
import { SourceActions } from "./SourceActions";

export function SourcesTab({ projectId }: { projectId?: string }) {
	const query = useSourcesPage({ project_id: projectId });
	const [creating, setCreating] = useState(false);
	const [secret, setSecret] = useState<string | null>(null);
	return (
		<div className="space-y-3">
			<div className="flex justify-end">
				<Can permission="config.write">
					<Button onClick={() => setCreating(true)}>New source</Button>
				</Can>
			</div>
			<CursorTable<Source>
				query={query}
				rowKey={(s) => s.id}
				empty="No sources yet."
				columns={[
					{ header: "Name", cell: (s) => s.name },
					{ header: "Ingress URL", cell: (s) => <IdText id={s.ingress_url} /> },
					{ header: "Auth", cell: (s) => s.auth_type },
					{
						header: "Destination",
						cell: (s) => <IdText id={s.destination_id} />,
					},
					{ header: "Status", cell: (s) => <StatusBadge status={s.status} /> },
					{ header: "", cell: (s) => <SourceActions source={s} /> },
				]}
			/>
			<SourceFormDialog
				open={creating}
				onOpenChange={setCreating}
				onCreated={(sec) => setSecret(sec)}
			/>
			<SecretRevealDialog
				secret={secret}
				label="Source secret"
				onClose={() => setSecret(null)}
			/>
		</div>
	);
}
