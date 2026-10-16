import { createFileRoute } from "@tanstack/react-router";
import { AuditPage, auditSearch } from "@/pages/AuditPage";

export const Route = createFileRoute("/audit")({
	validateSearch: auditSearch,
	component: function AuditRoute() {
		const search = Route.useSearch();
		const navigate = Route.useNavigate();
		return (
			<AuditPage
				search={search}
				setSearch={(s) => navigate({ search: (prev) => ({ ...prev, ...s }) })}
			/>
		);
	},
});
