import {
	createDestinationRequest,
	type Destination,
	patchDestinationRequest,
} from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { DirtyFormGuard } from "@/components/DirtyFormGuard";
import { FormField } from "@/components/FormField";
import { FormSection } from "@/components/FormSection";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, projectScopedPath } from "@/lib/api";
import { applyServerIssues, nullableNumber, optionalNumber } from "@/lib/forms";
import { useSettings } from "@/lib/queries/endpoints";
import { invalidateEndpointViews } from "@/lib/queries/invalidate-endpoint-views";
import { FieldError } from "./ProjectFormDialog";

const POLICY = [
	["timeout_ms", "Timeout (ms)"],
	["max_attempts", "Max attempts"],
	["backoff_base_s", "Backoff base (s)"],
	["backoff_max_s", "Backoff max (s)"],
] as const;

const LIMITS = [
	["max_in_flight", "Max in flight"],
	["rate_limit_per_s", "Rate limit (per s)"],
] as const;

type Values = {
	project_id?: string;
	name?: string;
	url?: string;
	timeout_ms?: number | null;
	max_attempts?: number | null;
	backoff_base_s?: number | null;
	backoff_max_s?: number | null;
	max_in_flight?: number | null;
	rate_limit_per_s?: number | null;
};

export function DestinationFormDialog({
	open,
	onOpenChange,
	projectId,
	destination,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	projectId: string;
	destination?: Destination;
	onCreated?: (secret: string) => void;
}) {
	if (!open) return null;
	return (
		<DestinationForm
			projectId={projectId}
			destination={destination}
			onDone={() => onOpenChange(false)}
			onCreated={onCreated}
		/>
	);
}

function DestinationForm({
	projectId,
	destination,
	onDone,
	onCreated,
}: {
	projectId: string;
	destination?: Destination;
	onDone: () => void;
	onCreated?: (secret: string) => void;
}) {
	const qc = useQueryClient();
	const editing = destination !== undefined;
	const defaults = useSettings().data?.retry_defaults;
	const form = useForm<Values>({
		resolver: zodResolver(
			(editing
				? patchDestinationRequest
				: createDestinationRequest) as z.ZodType<Values, Values>,
		),
		defaultValues: editing
			? {
					name: destination.name,
					url: destination.url,
					timeout_ms: destination.timeout_ms,
					max_attempts: destination.max_attempts,
					backoff_base_s: destination.backoff_base_s,
					backoff_max_s: destination.backoff_max_s,
					max_in_flight: destination.max_in_flight,
					rate_limit_per_s: destination.rate_limit_per_s,
				}
			: { project_id: projectId, name: "", url: "" },
	});
	const submit = form.handleSubmit(async (values) => {
		try {
			if (editing) {
				await api.patch(
					projectScopedPath(`/destinations/${destination.id}`, projectId),
					values,
				);
			} else {
				const res = await api.post<{ signing_secret: string }>(
					projectScopedPath("/destinations", projectId),
					values,
				);
				onCreated?.(res.signing_secret);
			}
			await invalidateEndpointViews(qc, "destination", projectId);
			onDone();
		} catch (err) {
			applyServerIssues(form, err);
		}
	});
	const e = form.formState.errors;
	return (
		<DirtyFormGuard dirty={form.formState.isDirty}>
			{(requestClose) => (
				<Dialog open onOpenChange={(o) => !o && requestClose(onDone)}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								{editing ? "Edit destination" : "New destination"}
							</DialogTitle>
						</DialogHeader>
						<form onSubmit={submit} className="space-y-3">
							<FormSection title="Destination">
								<FormField htmlFor="dst-name" label="Name">
									<Input id="dst-name" {...form.register("name")} />
									<FieldError message={e.name?.message} />
								</FormField>
								<FormField htmlFor="dst-url" label="URL">
									<Input
										id="dst-url"
										placeholder="https://…"
										{...form.register("url")}
									/>
									<FieldError message={e.url?.message} />
								</FormField>
							</FormSection>
							<FormSection
								title="Retry policy"
								description="Empty means inherit the workspace default."
							>
								<div className="grid grid-cols-2 gap-3">
									{POLICY.map(([key, label]) => {
										const fallback = defaults?.[key];
										return (
											<FormField key={key} htmlFor={`dst-${key}`} label={label}>
												<Input
													id={`dst-${key}`}
													type="number"
													placeholder={
														fallback === undefined
															? "default"
															: `default: ${fallback}`
													}
													{...form.register(
														key,
														editing ? nullableNumber : optionalNumber,
													)}
												/>
												<FieldError message={e[key]?.message} />
											</FormField>
										);
									})}
								</div>
							</FormSection>
							<FormSection
								title="Delivery limits"
								description="Empty means unlimited."
							>
								<div className="grid grid-cols-2 gap-3">
									{LIMITS.map(([key, label]) => (
										<FormField key={key} htmlFor={`dst-${key}`} label={label}>
											<Input
												id={`dst-${key}`}
												type="number"
												placeholder="Unlimited"
												{...form.register(
													key,
													editing ? nullableNumber : optionalNumber,
												)}
											/>
											<FieldError message={e[key]?.message} />
										</FormField>
									))}
								</div>
							</FormSection>
							<FieldError message={e.root?.message} />
							<DialogFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => requestClose(onDone)}
								>
									Cancel
								</Button>
								<Button type="submit" disabled={form.formState.isSubmitting}>
									{editing ? "Save" : "Create"}
								</Button>
							</DialogFooter>
						</form>
					</DialogContent>
				</Dialog>
			)}
		</DirtyFormGuard>
	);
}
