import {
	ALERT_CHANNEL_TYPES,
	ALERT_RULES,
	type AlertChannel,
	type AlertChannelType,
} from "@hookflare/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api } from "@/lib/api";
import { useProjectsList } from "@/lib/queries/projects";

function serverMessage(err: unknown): string {
	if (err instanceof ApiError) {
		const issues = err.body?.issues;
		if (Array.isArray(issues)) {
			const first = issues[0] as { message?: unknown } | undefined;
			if (typeof first?.message === "string") return first.message;
		}
		if (typeof err.body?.error === "string") return err.body.error;
		return err.message;
	}
	return String(err);
}

/** Config inputs are write-only: on edit, empty means "keep the current config" (spec §6.6). */
export function AlertChannelDialog({
	channel,
	onOpenChange,
	onSaved,
}: {
	channel?: AlertChannel;
	onOpenChange: (o: boolean) => void;
	onSaved: () => void;
}) {
	const editing = Boolean(channel);
	const projects = useProjectsList();
	const [name, setName] = useState(channel?.name ?? "");
	const [type, setType] = useState<AlertChannelType>(
		channel?.type ?? "discord",
	);
	const [url, setUrl] = useState("");
	const [botToken, setBotToken] = useState("");
	const [chatId, setChatId] = useState(channel?.chat_id ?? "");
	const [rules, setRules] = useState<string[]>(channel?.rules ?? []);
	const [projectIds, setProjectIds] = useState<string[]>(
		channel?.project_ids ?? [],
	);
	const [error, setError] = useState<string | null>(null);

	const configTouched =
		type === "telegram"
			? botToken !== "" || chatId !== (channel?.chat_id ?? "")
			: url !== "";
	const config =
		type === "telegram"
			? { type, bot_token: botToken, chat_id: chatId }
			: { type, url };
	const toggle = (list: string[], v: string) =>
		list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

	async function save() {
		if (editing && type === "telegram" && configTouched && botToken === "") {
			setError("Enter the bot token again to change the chat ID");
			return;
		}
		setError(null);
		const body = {
			name,
			rules,
			project_ids: projectIds,
			...(!editing || configTouched ? { config } : {}),
		};
		try {
			if (channel) await api.patch(`/alert-channels/${channel.id}`, body);
			else await api.post("/alert-channels", body);
			onSaved();
		} catch (err) {
			setError(serverMessage(err));
		}
	}

	const keep = channel
		? `Leave empty to keep ${channel.config_fingerprint}`
		: undefined;
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{editing ? "Edit channel" : "Add channel"}</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<div>
						<Label htmlFor="ach-name">Name</Label>
						<Input
							id="ach-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div>
						<Label htmlFor="ach-type">Type</Label>
						<select
							id="ach-type"
							className="block w-full rounded border px-2 py-1"
							value={type}
							disabled={editing}
							onChange={(e) => setType(e.target.value as AlertChannelType)}
						>
							{ALERT_CHANNEL_TYPES.map((t) => (
								<option key={t} value={t}>
									{t}
								</option>
							))}
						</select>
					</div>
					{type === "telegram" ? (
						<>
							<div>
								<Label htmlFor="ach-token">
									{editing ? "New bot token" : "Bot token"}
								</Label>
								<Input
									id="ach-token"
									type="password"
									autoComplete="off"
									placeholder={keep}
									value={botToken}
									onChange={(e) => setBotToken(e.target.value)}
								/>
							</div>
							<div>
								<Label htmlFor="ach-chat">Chat ID</Label>
								<Input
									id="ach-chat"
									value={chatId}
									onChange={(e) => setChatId(e.target.value)}
								/>
							</div>
						</>
					) : (
						<div>
							<Label htmlFor="ach-url">
								{editing ? "New webhook URL" : "Webhook URL"}
							</Label>
							<Input
								id="ach-url"
								type="password"
								autoComplete="off"
								placeholder={keep}
								value={url}
								onChange={(e) => setUrl(e.target.value)}
							/>
						</div>
					)}
					<fieldset>
						<legend className="text-sm font-medium">
							Rules (none checked = all)
						</legend>
						{ALERT_RULES.map((r) => (
							<div key={r} className="flex items-center gap-2 text-sm">
								<Checkbox
									id={`ach-rule-${r}`}
									checked={rules.includes(r)}
									onCheckedChange={() => setRules((s) => toggle(s, r))}
								/>
								<Label htmlFor={`ach-rule-${r}`}>{r}</Label>
							</div>
						))}
					</fieldset>
					<fieldset>
						<legend className="text-sm font-medium">
							Projects (none checked = all, including system alerts)
						</legend>
						{(projects.data?.data ?? []).map((p) => (
							<div key={p.id} className="flex items-center gap-2 text-sm">
								<Checkbox
									id={`ach-proj-${p.id}`}
									checked={projectIds.includes(p.id)}
									onCheckedChange={() => setProjectIds((s) => toggle(s, p.id))}
								/>
								<Label htmlFor={`ach-proj-${p.id}`}>{p.name}</Label>
							</div>
						))}
					</fieldset>
					{error && <p className="text-sm text-red-700">{error}</p>}
				</div>
				<DialogFooter>
					<Button onClick={save}>Save</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
