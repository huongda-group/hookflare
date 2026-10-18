import {
	createDestinationRequest,
	type Destination,
	patchDestinationRequest,
} from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { DirtyFormGuard } from "@/components/DirtyFormGuard";
import { FormSection } from "@/components/FormSection";
import { ResourcePicker } from "@/components/ResourcePicker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { applyServerIssues, nullableNumber, optionalNumber } from "@/lib/forms";
import { useSettings } from "@/lib/queries/endpoints";
import { qk } from "@/lib/queries/keys";
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

/**
 * Empty policy fields mean "use the default"; on edit, emptying sends null
 * (spec §10). The project picker pages past the old single-page limit
 * (spec §7); the project is create-only — the strict patch schema rejects it.
 */
export function DestinationFormDialog({
	open,
	onOpenChange,
	destination,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	destination?: Destination;
	onCreated?: (secret: string) => void;
}) {
	// Unmount on close so every open starts from the current destination.
	if (!open) return null;
	return (
		<DestinationForm
			destination={destination}
			onDone={() => onOpenChange(false)}
			onCreated={onCreated}
		/>
	);
}

function DestinationForm({
	destination,
	onDone,
	onCreated,
}: {
	destination?: Destination;
	onDone: () => void;
	onCreated?: (secret: string) => void;
}) {
	const qc = useQueryClient();
	const editing = destination !== undefined;
	const defaults = useSettings().data?.retry_defaults;
	const form = useForm<Values>({
		resolver: zodResolver(
			(editing ? patchDestinationRequest : createDestinationRequest) as never,
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
			: { name: "", url: "" },
	});
	const submit = form.handleSubmit(async (values) => {
		try {
			if (editing) {
				await api.patch(`/destinations/${destination.id}`, values);
			} else {
				const res = await api.post<{ signing_secret: string }>(
					"/destinations",
					values,
				);
				onCreated?.(res.signing_secret);
			}
			await qc.invalidateQueries({ queryKey: qk.destinations.all });
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
								{!editing && (
									<div>
										<Label>Project</Label>
										<Controller
											control={form.control}
											name="project_id"
											render={({ field }) => (
												<ResourcePicker
													kind="project"
													label="Project"
													value={field.value}
													onChange={field.onChange}
												/>
											)}
										/>
										<FieldError message={e.project_id?.message} />
									</div>
								)}
								<div>
									<Label htmlFor="dst-name">Name</Label>
									<Input id="dst-name" {...form.register("name")} />
									<FieldError message={e.name?.message} />
								</div>
								<div>
									<Label htmlFor="dst-url">URL</Label>
									<Input
										id="dst-url"
										placeholder="https://…"
										{...form.register("url")}
									/>
									<FieldError message={e.url?.message} />
								</div>
							</FormSection>
							<FormSection
								title="Retry policy"
								description="Empty means inherit the workspace default."
							>
								<div className="grid grid-cols-2 gap-3">
									{POLICY.map(([key, label]) => {
										const fallback = defaults?.[key];
										return (
											<div key={key}>
												<Label htmlFor={`dst-${key}`}>{label}</Label>
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
											</div>
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
										<div key={key}>
											<Label htmlFor={`dst-${key}`}>{label}</Label>
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
										</div>
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
