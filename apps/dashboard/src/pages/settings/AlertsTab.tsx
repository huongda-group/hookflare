import {
	type AlertChannel,
	type AlertRules,
	alertRulesSchema,
	type ChannelTestResult,
} from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { AlertChannelDialog } from "@/components/AlertChannelDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FieldError } from "@/components/ProjectFormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { applyServerIssues } from "@/lib/forms";
import { useSettings } from "@/lib/queries/endpoints";
import { qk } from "@/lib/queries/keys";

const RULE_FIELDS = [
	["failure_threshold", "Failure threshold"],
	["stuck_after_s", "Stuck after (s)"],
	["dead_quiet_s", "Dead quiet period (s)"],
	["d1_warn_pct", "D1 warning (%)"],
	["reminder_s", "Reminder every (s, 0 = never)"],
] as const;

export function AlertsTab() {
	const settings = useSettings();
	return (
		<div className="space-y-8">
			{settings.data ? (
				<RulesForm initial={settings.data.alert_rules} />
			) : (
				<p className="text-neutral-500">Loading…</p>
			)}
			<Channels />
		</div>
	);
}

function RulesForm({ initial }: { initial: AlertRules }) {
	const qc = useQueryClient();
	const [saved, setSaved] = useState(false);
	const form = useForm<AlertRules>({
		resolver: zodResolver(alertRulesSchema),
		defaultValues: initial,
	});
	const submit = form.handleSubmit(async (alert_rules) => {
		setSaved(false);
		try {
			await api.patch("/settings", { alert_rules });
			await qc.invalidateQueries({ queryKey: qk.settings });
			setSaved(true);
		} catch (err) {
			applyServerIssues(form, err);
		}
	});
	const e = form.formState.errors;
	return (
		<form onSubmit={submit} className="max-w-xl space-y-4">
			<h2 className="font-medium">Rules</h2>
			<div className="grid grid-cols-2 gap-3">
				{RULE_FIELDS.map(([key, label]) => (
					<div key={key}>
						<Label htmlFor={`ar-${key}`}>{label}</Label>
						<Input
							id={`ar-${key}`}
							type="number"
							{...form.register(key, { valueAsNumber: true })}
						/>
						<FieldError message={e[key]?.message} />
					</div>
				))}
			</div>
			<FieldError message={e.root?.message} />
			<Button type="submit" disabled={form.formState.isSubmitting}>
				Save rules
			</Button>
			{saved && (
				<p className="text-sm text-green-800">
					Saved. Applies within about a minute.
				</p>
			)}
		</form>
	);
}

function Channels() {
	const qc = useQueryClient();
	const list = useQuery({
		queryKey: qk.alertChannels.all,
		queryFn: () => api.get<{ data: AlertChannel[] }>("/alert-channels"),
	});
	const [editing, setEditing] = useState<AlertChannel | "new" | null>(null);
	const [deleting, setDeleting] = useState<AlertChannel | null>(null);
	const [results, setResults] = useState<Record<string, ChannelTestResult>>({});
	const invalidate = () =>
		qc.invalidateQueries({ queryKey: qk.alertChannels.all });
	const test = useMutation({
		mutationFn: (id: string) =>
			api.post<ChannelTestResult>(`/alert-channels/${id}/test`),
		onSuccess: (r, id) => setResults((s) => ({ ...s, [id]: r })),
	});
	const toggle = useMutation({
		mutationFn: (c: AlertChannel) =>
			api.patch(`/alert-channels/${c.id}`, { enabled: !c.enabled }),
		onSuccess: invalidate,
	});
	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between">
				<h2 className="font-medium">Channels</h2>
				<Button onClick={() => setEditing("new")}>Add channel</Button>
			</div>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						<TableHead>Type</TableHead>
						<TableHead>Fingerprint</TableHead>
						<TableHead>Rules</TableHead>
						<TableHead>Projects</TableHead>
						<TableHead />
					</TableRow>
				</TableHeader>
				<TableBody>
					{(list.data?.data ?? []).map((c) => (
						<TableRow key={c.id}>
							<TableCell>
								{c.name}
								{c.enabled ? "" : " (disabled)"}
							</TableCell>
							<TableCell>
								{c.type}
								{c.chat_id ? ` · ${c.chat_id}` : ""}
							</TableCell>
							<TableCell className="font-mono">
								{c.config_fingerprint}
							</TableCell>
							<TableCell>
								{c.rules.length ? c.rules.join(", ") : "All"}
							</TableCell>
							<TableCell>
								{c.project_ids.length ? c.project_ids.length : "All"}
							</TableCell>
							<TableCell className="space-x-2 text-right">
								<Button
									size="sm"
									variant="outline"
									onClick={() => test.mutate(c.id)}
								>
									Send test
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => toggle.mutate(c)}
								>
									{c.enabled ? "Disable" : "Enable"}
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => setEditing(c)}
								>
									Edit
								</Button>
								<Button
									size="sm"
									variant="destructive"
									onClick={() => setDeleting(c)}
								>
									Delete
								</Button>
								{results[c.id] && (
									<span
										className={
											results[c.id].ok ? "text-green-800" : "text-red-700"
										}
									>
										{results[c.id].ok
											? "Sent"
											: `Failed: ${results[c.id].error}`}
									</span>
								)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			{editing && (
				<AlertChannelDialog
					channel={editing === "new" ? undefined : editing}
					onOpenChange={(o) => !o && setEditing(null)}
					onSaved={() => {
						setEditing(null);
						invalidate();
					}}
				/>
			)}
			{deleting && (
				<ConfirmDialog
					open
					title={`Delete ${deleting.name}?`}
					description="Its notification history is deleted too."
					confirmLabel="Delete"
					onOpenChange={(o) => !o && setDeleting(null)}
					onConfirm={async () => {
						await api.delete(`/alert-channels/${deleting.id}`);
						setDeleting(null);
						invalidate();
					}}
				/>
			)}
		</section>
	);
}
