import { z } from "zod";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useActiveProject } from "@/lib/project-selection";
import { DestinationsTab } from "./endpoints/DestinationsTab";
import { SourcesTab } from "./endpoints/SourcesTab";

export const endpointsSearch = z.object({
	tab: z
		.enum(["sources", "destinations"])
		.default("destinations")
		.catch("destinations"),
	project_id: z.string().optional().catch(undefined),
});
export type EndpointsSearch = z.infer<typeof endpointsSearch>;

export function EndpointsPage({
	search,
	setSearch,
}: {
	search: EndpointsSearch;
	setSearch: (s: Partial<EndpointsSearch>) => void;
}) {
	const { projectId } = useActiveProject();
	if (!projectId) return null;
	return (
		<div className="space-y-4">
			<h1 className="text-xl font-semibold">Endpoints</h1>
			<Tabs
				value={search.tab}
				onValueChange={(tab) =>
					setSearch({ tab: tab as EndpointsSearch["tab"] })
				}
			>
				<TabsList>
					<TabsTrigger value="sources">Sources</TabsTrigger>
					<TabsTrigger value="destinations">Destinations</TabsTrigger>
				</TabsList>
				<TabsContent value="sources">
					<SourcesTab projectId={projectId} />
				</TabsContent>
				<TabsContent value="destinations">
					<DestinationsTab projectId={projectId} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
