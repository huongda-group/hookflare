import { type RetryDefaults, retryDefaultsSchema } from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { DirtyFormGuard } from "@/components/DirtyFormGuard";
import { FormSection } from "@/components/FormSection";
import { FieldError } from "@/components/ProjectFormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { applyServerIssues } from "@/lib/forms";
import { useCan } from "@/lib/permissions";
import { useSettings } from "@/lib/queries/endpoints";
import { qk } from "@/lib/queries/keys";

const FIELDS = [
	["timeout_ms", "Timeout (ms)"],
	["max_attempts", "Max attempts"],
	["backoff_base_s", "Backoff base (s)"],
	["backoff_max_s", "Backoff max (s)"],
] as const;

export function RetryDefaultsTab() {
	const settings = useSettings();
	if (!settings.data) return <p className="text-muted-foreground">Loading…</p>;
	return <RetryDefaultsForm initial={settings.data.retry_defaults} />;
}

function RetryDefaultsForm({ initial }: { initial: RetryDefaults }) {
	const qc = useQueryClient();
	const canEdit = useCan("settings.manage");
	const [reason, setReason] = useState("");
	const [saved, setSaved] = useState(false);
	const form = useForm<RetryDefaults>({
		resolver: zodResolver(retryDefaultsSchema),
		defaultValues: initial,
	});
	const reasonTooLong = reason.trim().length > 500;
	const dirty = form.formState.isDirty || reason !== "";
	const submit = form.handleSubmit(async (retry_defaults) => {
		setSaved(false);
		if (reasonTooLong) return;
		try {
			await api.patch("/settings", {
				retry_defaults,
				...(reason.trim() ? { reason: reason.trim() } : {}),
			});
			await qc.invalidateQueries({ queryKey: qk.settings });
			form.reset(retry_defaults);
			setSaved(true);
			setReason("");
		} catch (err) {
			applyServerIssues(form, err);
		}
	});
	const e = form.formState.errors;
	return (
		<DirtyFormGuard dirty={canEdit && dirty}>
			{() => (
				<form onSubmit={submit} className="max-w-xl space-y-4">
					<FormSection
						title="Retry defaults"
						description="Used by every destination that has no override."
					>
						<div className="grid grid-cols-2 gap-3">
							{FIELDS.map(([key, label]) => (
								<div key={key}>
									<Label htmlFor={`rd-${key}`}>{label}</Label>
									<Input
										id={`rd-${key}`}
										type="number"
										disabled={!canEdit}
										{...form.register(key, { valueAsNumber: true })}
									/>
									<FieldError message={e[key]?.message} />
								</div>
							))}
						</div>
						{canEdit ? (
							<>
								<div>
									<Label htmlFor="rd-reason">Reason (optional)</Label>
									<Textarea
										id="rd-reason"
										value={reason}
										onChange={(ev) => setReason(ev.target.value)}
									/>
									{reasonTooLong && (
										<p className="text-sm text-failure">
											Reason must be 500 characters or fewer.
										</p>
									)}
								</div>
								<FieldError message={e.root?.message} />
								<div className="flex gap-2">
									<Button type="submit" disabled={form.formState.isSubmitting}>
										Save
									</Button>
									<Button
										type="button"
										variant="outline"
										onClick={() => {
											form.reset(initial);
											setReason("");
											setSaved(false);
										}}
									>
										Revert
									</Button>
								</div>
								{saved && (
									<p className="text-sm text-success">
										Saved. Applies to new attempts within 30 seconds.
									</p>
								)}
							</>
						) : (
							<p className="text-sm text-muted-foreground">
								You need settings.manage permission to change these values.
							</p>
						)}
					</FormSection>
				</form>
			)}
		</DirtyFormGuard>
	);
}
