import { z } from "zod";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCan } from "@/lib/permissions";
import { RetryDefaultsTab } from "./settings/RetryDefaultsTab";
import { UsersTab } from "./settings/UsersTab";

export const settingsSearch = z.object({
	tab: z.enum(["retry", "users"]).default("retry").catch("retry"),
});
export type SettingsSearch = z.infer<typeof settingsSearch>;

export function SettingsPage({
	search,
	setSearch,
}: {
	search: SettingsSearch;
	setSearch: (s: SettingsSearch) => void;
}) {
	const canUsers = useCan("users.manage");
	const tab = canUsers ? search.tab : "retry";
	return (
		<div className="space-y-4">
			<h1 className="text-xl font-semibold">Settings</h1>
			<Tabs
				value={tab}
				onValueChange={(v) => setSearch({ tab: v as SettingsSearch["tab"] })}
			>
				<TabsList>
					<TabsTrigger value="retry">Retry defaults</TabsTrigger>
					{canUsers && <TabsTrigger value="users">Users</TabsTrigger>}
				</TabsList>
				<TabsContent value="retry">
					<RetryDefaultsTab />
				</TabsContent>
				{canUsers && (
					<TabsContent value="users">
						<UsersTab />
					</TabsContent>
				)}
			</Tabs>
		</div>
	);
}
