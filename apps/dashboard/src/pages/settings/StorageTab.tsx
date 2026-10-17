import {
	type ArchivePreview,
	type BackupSummary,
	type StorageSettings,
	storageSettingsSchema,
} from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { FieldError } from "@/components/ProjectFormDialog";
import { TimeText } from "@/components/TimeText";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api, runBackupNow } from "@/lib/api";
import { applyServerIssues } from "@/lib/forms";
import { Can } from "@/lib/permissions";
import { useBackupSummary, useSettings } from "@/lib/queries/endpoints";
import { qk } from "@/lib/queries/keys";

const DAYS = [
	["hot_retention_days", "Hot retention (days)"],
	["failed_retention_days", "Failed retention (days)"],
	["audit_retention_days", "Audit retention (days)"],
] as const;

export function StorageTab() {
	const settings = useSettings();
	if (!settings.data) return <p className="text-neutral-500">Loading…</p>;
	return (
		<div className="space-y-8">
			<StorageForm initial={settings.data.storage} />
			<BackupStatus />
			<LastRun run={settings.data.archive_last_run} />
		</div>
	);
}

function StorageForm({ initial }: { initial: StorageSettings }) {
	const qc = useQueryClient();
	const [confirm, setConfirm] = useState<{
		value: StorageSettings;
		extra: number;
	} | null>(null);
	const [saved, setSaved] = useState(false);
	type StorageFormValues = z.input<typeof storageSettingsSchema>;
	const form = useForm<StorageFormValues>({
		resolver: zodResolver(storageSettingsSchema),
		defaultValues: initial,
	});

	async function write(storage: StorageSettings) {
		try {
			await api.patch("/settings", { storage });
			await qc.invalidateQueries({ queryKey: qk.settings });
			setConfirm(null);
			setSaved(true);
		} catch (err) {
			applyServerIssues(form, err);
		}
	}

	const submit = form.handleSubmit(async (value) => {
		setSaved(false);
		// The schema defaults fill the backup fields when untouched.
		const storage: StorageSettings = storageSettingsSchema.parse(value);
		const lowered =
			storage.hot_retention_days < initial.hot_retention_days ||
			storage.failed_retention_days < initial.failed_retention_days;
		if (!lowered) return write(storage);
		const p = await api.get<ArchivePreview>("/archives/preview", {
			hot_retention_days: storage.hot_retention_days,
			failed_retention_days: storage.failed_retention_days,
		});
		setConfirm({
			value: storage,
			extra: Math.max(0, p.eligible - p.currently_eligible),
		});
	});

	const e = form.formState.errors;
	const backupEnabled = form.watch("backup_enabled") ?? true;
	return (
		<form onSubmit={submit} className="max-w-xl space-y-4">
			<div className="flex items-center gap-2 text-sm">
				<Checkbox
					id="st-archive_enabled"
					checked={form.watch("archive_enabled")}
					onCheckedChange={(v) => form.setValue("archive_enabled", v === true)}
				/>
				<Label htmlFor="st-archive_enabled">
					Archive to R2 before deleting (off = delete without files)
				</Label>
			</div>
			<div className="grid grid-cols-2 gap-3">
				{DAYS.map(([key, label]) => (
					<div key={key}>
						<Label htmlFor={`st-${key}`}>{label}</Label>
						<Input
							id={`st-${key}`}
							type="number"
							{...form.register(key, { valueAsNumber: true })}
						/>
						<FieldError message={e[key]?.message} />
					</div>
				))}
				<div>
					<Label htmlFor="st-archive_retention_days">
						Archive retention (days, empty = forever)
					</Label>
					<Input
						id="st-archive_retention_days"
						type="number"
						{...form.register("archive_retention_days", {
							setValueAs: (v) => (v === "" || v === null ? null : Number(v)),
						})}
					/>
					<FieldError message={e.archive_retention_days?.message} />
				</div>
			</div>
			<div className="flex items-center gap-2 text-sm">
				<Checkbox
					id="st-backup_enabled"
					checked={backupEnabled}
					onCheckedChange={(v) => form.setValue("backup_enabled", v === true)}
				/>
				<Label htmlFor="st-backup_enabled">Daily backup</Label>
			</div>
			{!backupEnabled && (
				<p
					role="alert"
					className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
				>
					Daily backups are off. Only D1 Time Travel (30 days) can restore this
					database.
				</p>
			)}
			<div className="max-w-xs">
				<Label htmlFor="st-backup_retention_days">
					Backup retention (days)
				</Label>
				<Input
					id="st-backup_retention_days"
					type="number"
					{...form.register("backup_retention_days", { valueAsNumber: true })}
				/>
				<FieldError message={e.backup_retention_days?.message} />
			</div>
			<FieldError message={e.root?.message} />
			{confirm ? (
				<div
					role="alertdialog"
					className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
				>
					<p>
						{confirm.extra.toLocaleString("en-US")} more events become eligible
						for archiving and deletion at the next run.
					</p>
					<Button type="button" onClick={() => write(confirm.value)}>
						Save anyway
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => setConfirm(null)}
					>
						Cancel
					</Button>
				</div>
			) : (
				<Button type="submit" disabled={form.formState.isSubmitting}>
					Save storage
				</Button>
			)}
			{saved && (
				<p className="text-sm text-green-800">
					Saved. Applies to the next archive run.
				</p>
			)}
		</form>
	);
}

function BackupStatus() {
	const qc = useQueryClient();
	const summary = useBackupSummary();
	const [started, setStarted] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function runNow() {
		setPending(true);
		setError(null);
		try {
			const r = await runBackupNow();
			setStarted(r.backup_id);
			await qc.invalidateQueries({ queryKey: qk.backups.summary });
		} catch (err) {
			if (err instanceof ApiError && err.code === "backup_running") {
				setError("A backup is already running");
			} else {
				setError(err instanceof Error ? err.message : "Failed to start backup");
			}
		} finally {
			setPending(false);
		}
	}

	const running = summary.data?.running ?? null;
	return (
		<section className="space-y-2">
			<h2 className="font-medium">Backups</h2>
			<SummaryBlock summary={summary.data ?? null} />
			<Can permission="settings.manage">
				<Button
					variant="outline"
					onClick={runNow}
					disabled={running !== null || pending}
				>
					Run backup now
				</Button>
			</Can>
			{started && <p className="text-sm text-green-800">Started {started}.</p>}
			{error && <p className="text-sm text-red-800">{error}</p>}
		</section>
	);
}

function SummaryBlock({ summary }: { summary: BackupSummary | null }) {
	if (!summary) return <p className="text-sm">Loading…</p>;
	const { last_verified: verified, last_failed: failed } = summary;
	const showFailure =
		failed !== null &&
		(verified === null || failed.started_at > verified.started_at);
	return (
		<div className="space-y-1 text-sm">
			{verified ? (
				<p>
					Last verified backup {verified.id}, finished{" "}
					<TimeText ms={verified.finished_at} />,{" "}
					{verified.bytes.toLocaleString("en-US")} bytes,{" "}
					{verified.rows.toLocaleString("en-US")} rows.
				</p>
			) : (
				<p>No verified backup yet.</p>
			)}
			{showFailure && failed && (
				<p>
					Last failure {failed.id}, started <TimeText ms={failed.started_at} />
					{failed.error ? `: ${failed.error}` : "."}
				</p>
			)}
			{summary.running && (
				<p>
					Running {summary.running.id} ({summary.running.instance_id}), started{" "}
					<TimeText ms={summary.running.started_at} />
				</p>
			)}
		</div>
	);
}

function LastRun({
	run,
}: {
	run: { instance_id: string; status: string; started_at: number } | null;
}) {
	const qc = useQueryClient();
	const [started, setStarted] = useState<string | null>(null);
	async function runNow() {
		const r = await api.post<{ instance_id: string }>("/archives/run", {});
		setStarted(r.instance_id);
		await qc.invalidateQueries({ queryKey: qk.settings });
	}
	return (
		<section className="space-y-2">
			<h2 className="font-medium">Archive runs</h2>
			<p className="text-sm">
				{run ? (
					<>
						Last run {run.instance_id} ({run.status}), started{" "}
						<TimeText ms={run.started_at} />
					</>
				) : (
					"No run yet."
				)}
			</p>
			<Button variant="outline" onClick={runNow}>
				Run now
			</Button>
			{started && <p className="text-sm text-green-800">Started {started}.</p>}
		</section>
	);
}
