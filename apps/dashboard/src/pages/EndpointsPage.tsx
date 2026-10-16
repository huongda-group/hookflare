import { z } from "zod";
import { ProjectSelect } from "@/components/ProjectSelect";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DestinationsTab } from "./endpoints/DestinationsTab";

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
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold">Endpoints</h1>
				<ProjectSelect
					value={search.project_id}
					onChange={(project_id) => setSearch({ project_id })}
					label="Filter by project"
				/>
			</div>
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
					<p className="text-neutral-500">Sources</p>
				</TabsContent>
				<TabsContent value="destinations">
					<DestinationsTab projectId={search.project_id} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
