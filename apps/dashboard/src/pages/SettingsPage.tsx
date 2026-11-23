import { z } from "zod";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCan } from "@/lib/permissions";
import { AlertsTab } from "./settings/AlertsTab";
import { RetryDefaultsTab } from "./settings/RetryDefaultsTab";
import { StorageTab } from "./settings/StorageTab";
import { UsersTab } from "./settings/UsersTab";

export const settingsSearch = z.object({
	tab: z
		.enum(["retry", "storage", "alerts", "users"])
		.default("retry")
		.catch("retry"),
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
	const canManage = useCan("settings.manage");
	const allowed = {
		retry: true,
		storage: canManage,
		alerts: canManage,
		users: canUsers,
	} as const;
	const tab = allowed[search.tab] ? search.tab : "retry";
	return (
		<div className="space-y-4">
			<PageHeader
				title="Settings"
				description="Retry defaults, storage and backups, alerting, and user administration."
			/>
			<Tabs
				value={tab}
				onValueChange={(v) => setSearch({ tab: v as SettingsSearch["tab"] })}
			>
				<TabsList>
					<TabsTrigger value="retry">Retry defaults</TabsTrigger>
					{canManage && <TabsTrigger value="storage">Storage</TabsTrigger>}
					{canManage && <TabsTrigger value="alerts">Alerts</TabsTrigger>}
					{canUsers && <TabsTrigger value="users">Users</TabsTrigger>}
				</TabsList>
				<TabsContent value="retry">
					<RetryDefaultsTab />
				</TabsContent>
				{canManage && (
					<TabsContent value="storage">
						<StorageTab />
					</TabsContent>
				)}
				{canManage && (
					<TabsContent value="alerts">
						<AlertsTab />
					</TabsContent>
				)}
				{canUsers && (
					<TabsContent value="users">
						<UsersTab />
					</TabsContent>
				)}
			</Tabs>
		</div>
	);
}
