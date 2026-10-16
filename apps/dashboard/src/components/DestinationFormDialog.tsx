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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { applyServerIssues, nullableNumber, optionalNumber } from "@/lib/forms";
import { useSettings } from "@/lib/queries/endpoints";
import { qk } from "@/lib/queries/keys";
import { useProjectsList } from "@/lib/queries/projects";
import { FieldError } from "./ProjectFormDialog";

const POLICY = [
	["timeout_ms", "Timeout (ms)"],
	["max_attempts", "Max attempts"],
	["backoff_base_s", "Backoff base (s)"],
	["backoff_max_s", "Backoff max (s)"],
] as const;

type Values = {
	project_id?: string;
	name?: string;
	url?: string;
	timeout_ms?: number | null;
	max_attempts?: number | null;
	backoff_base_s?: number | null;
	backoff_max_s?: number | null;
};

/** Empty policy fields mean "use the default"; on edit, emptying sends null (spec §10). */
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
	const qc = useQueryClient();
	const editing = destination !== undefined;
	const defaults = useSettings().data?.retry_defaults;
	const projects = useProjectsList();
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
			form.reset();
			onOpenChange(false);
		} catch (err) {
			applyServerIssues(form, err);
		}
	});
	const e = form.formState.errors;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{editing ? "Edit destination" : "New destination"}
					</DialogTitle>
				</DialogHeader>
				<form onSubmit={submit} className="space-y-3">
					{!editing && (
						<div>
							<Label htmlFor="dst-project">Project</Label>
							<Controller
								control={form.control}
								name="project_id"
								render={({ field }) => (
									<Select value={field.value} onValueChange={field.onChange}>
										<SelectTrigger id="dst-project" aria-label="Project">
											<SelectValue placeholder="Choose a project" />
										</SelectTrigger>
										<SelectContent>
											{projects.data?.data.map((p) => (
												<SelectItem key={p.id} value={p.id}>
													{p.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
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
					<fieldset className="grid grid-cols-2 gap-3">
						<legend className="mb-1 text-sm font-medium">
							Retry policy (empty = default)
						</legend>
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
					</fieldset>
					<FieldError message={e.root?.message} />
					<DialogFooter>
						<Button type="submit" disabled={form.formState.isSubmitting}>
							{editing ? "Save" : "Create"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
