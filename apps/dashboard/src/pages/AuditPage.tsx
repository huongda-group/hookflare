import type { AuditLog, Page } from "@hookflare/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { CursorTable } from "@/components/CursorTable";
import { IdText } from "@/components/IdText";
import { JsonViewer } from "@/components/JsonViewer";
import { TimeText } from "@/components/TimeText";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { qk } from "@/lib/queries/keys";

export const auditSearch = z.object({
	actor: z.string().optional().catch(undefined),
	action: z.string().optional().catch(undefined),
	resource_type: z.string().optional().catch(undefined),
	resource_id: z.string().optional().catch(undefined),
});
export type AuditSearch = z.infer<typeof auditSearch>;

function Diff({ diff }: { diff: unknown }) {
	const [open, setOpen] = useState(false);
	if (diff === null || diff === undefined)
		return <span className="text-neutral-400">—</span>;
	return (
		<div>
			<button
				type="button"
				className="text-xs underline"
				onClick={() => setOpen(!open)}
			>
				{open ? "Hide diff" : "Show diff"}
			</button>
			{open && <JsonViewer value={diff} />}
		</div>
	);
}

export function AuditPage({
	search,
	setSearch,
}: {
	search: AuditSearch;
	setSearch: (s: Partial<AuditSearch>) => void;
}) {
	const allowed = useCan("audit.read");
	const query = useInfiniteQuery({
		queryKey: qk.audit.list(search),
		enabled: allowed,
		queryFn: ({ pageParam }) =>
			api.get<Page<AuditLog>>("/audit-logs", {
				...search,
				limit: 50,
				cursor: pageParam,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
	if (!allowed) return <p>The audit log requires the admin role.</p>;
	const filter = (key: keyof AuditSearch, label: string) => (
		<div>
			<Label htmlFor={`a-${key}`}>{label}</Label>
			<Input
				id={`a-${key}`}
				className="w-48"
				// Keyed on the URL value so back/forward refreshes the uncontrolled input.
				key={search[key] ?? ""}
				defaultValue={search[key]}
				onBlur={(e) => setSearch({ [key]: e.target.value || undefined })}
			/>
		</div>
	);
	return (
		<div className="space-y-4">
			<h1 className="text-xl font-semibold">Audit</h1>
			<div className="flex flex-wrap gap-3">
				{filter("actor", "Actor")}
				{filter("action", "Action")}
				{filter("resource_type", "Resource type")}
				{filter("resource_id", "Resource ID")}
			</div>
			<CursorTable<AuditLog>
				query={query}
				rowKey={(a) => a.id}
				empty="No audit entries match."
				columns={[
					{ header: "At", cell: (a) => <TimeText ms={a.at} /> },
					{ header: "Actor", cell: (a) => a.actor },
					{
						header: "Action",
						cell: (a) => <span className="font-mono text-xs">{a.action}</span>,
					},
					{
						header: "Resource",
						cell: (a) => (
							<span>
								{a.resource_type}{" "}
								{a.resource_id && <IdText id={a.resource_id} />}
							</span>
						),
					},
					{ header: "Reason", cell: (a) => a.reason ?? "—" },
					{ header: "Diff", cell: (a) => <Diff diff={a.diff} /> },
				]}
			/>
		</div>
	);
}
