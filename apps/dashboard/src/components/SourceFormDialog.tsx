import {
	AUTH_TYPES,
	createSourceRequest,
	EVENT_ID_FROM,
	patchSourceRequest,
	type Source,
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { applyServerIssues, nullableNumber, optionalNumber } from "@/lib/forms";
import { qk } from "@/lib/queries/keys";
import { FieldError } from "./ProjectFormDialog";

const AUTH_LABEL: Record<(typeof AUTH_TYPES)[number], string> = {
	none: "None",
	hmac: "HMAC signature",
	token: "Shared token",
};
const EVENT_ID_LABEL: Record<(typeof EVENT_ID_FROM)[number], string> = {
	none: "Off",
	header: "Header",
	json_path: "JSON path",
};

type Values = {
	project_id?: string;
	destination_id?: string;
	name?: string;
	auth_type: (typeof AUTH_TYPES)[number];
	auth_config: Record<string, unknown>;
	secret?: string;
	event_id_from: (typeof EVENT_ID_FROM)[number];
	event_id_selector?: string | null;
	max_body_bytes?: number | null;
};

function SimpleSelect({
	id,
	label,
	value,
	onChange,
	options,
}: {
	id: string;
	label: string;
	value?: string;
	onChange: (v: string) => void;
	options: [string, string][];
}) {
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger id={id} aria-label={label}>
				<SelectValue placeholder={`Choose ${label.toLowerCase()}`} />
			</SelectTrigger>
			<SelectContent>
				{options.map(([v, l]) => (
					<SelectItem key={v} value={v}>
						{l}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * Create: the whole discriminated body is validated by createSourceRequest.
 * Edit: auth_type is fixed (M3 stores it per source), and the strict patch
 * schema rejects project_id, auth_type, and secret, so they never appear in
 * the edit values. The project and destination pickers page past the old
 * single-page limit (spec §7); auth selects stay plain selects.
 */
export function SourceFormDialog({
	open,
	onOpenChange,
	source,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	source?: Source;
	onCreated?: (secret: string | null) => void;
}) {
	// Unmount on close so every open starts from the current source.
	if (!open) return null;
	return (
		<SourceForm
			source={source}
			onDone={() => onOpenChange(false)}
			onCreated={onCreated}
		/>
	);
}

function SourceForm({
	source,
	onDone,
	onCreated,
}: {
	source?: Source;
	onDone: () => void;
	onCreated?: (secret: string | null) => void;
}) {
	const qc = useQueryClient();
	const editing = source !== undefined;
	const form = useForm<Values>({
		resolver: zodResolver(
			(editing ? patchSourceRequest : createSourceRequest) as never,
		),
		defaultValues: editing
			? {
					name: source.name,
					destination_id: source.destination_id,
					auth_config: source.auth_config,
					event_id_from: source.event_id_from,
					event_id_selector: source.event_id_selector,
					max_body_bytes: source.max_body_bytes,
				}
			: { name: "", auth_type: "none", auth_config: {}, event_id_from: "none" },
	});
	const watchedAuthType = form.watch("auth_type");
	const authType = editing ? source.auth_type : watchedAuthType;
	const eventFrom = form.watch("event_id_from");
	const projectId = editing ? source.project_id : form.watch("project_id");

	const setAuthType = (t: Values["auth_type"]) => {
		form.setValue("auth_type", t);
		// Hidden fields keep their values (shouldUnregister is off), and the strict
		// create schema rejects a `secret` key (even an undefined one) for
		// auth_type "none" with an error no visible field shows. Remove the key,
		// and every auth-specific error, on each switch.
		form.unregister("secret");
		form.clearErrors(["secret", "auth_config"]);
		form.setValue(
			"auth_config",
			t === "hmac"
				? { header: "", algorithm: "sha256", encoding: "hex" }
				: t === "token"
					? { in: "header", name: "" }
					: {},
		);
	};

	const submit = form.handleSubmit(async (values) => {
		const body = { ...values };
		if (!body.secret) delete body.secret;
		if (body.event_id_from === "none")
			body.event_id_selector = editing ? null : undefined;
		try {
			if (editing) {
				const { secret: _s, project_id: _p, ...patch } = body;
				await api.patch(`/sources/${source.id}`, patch);
			} else {
				const res = await api.post<{ secret?: string }>("/sources", body);
				onCreated?.(res.secret ?? null);
			}
			await qc.invalidateQueries({ queryKey: qk.sources.all });
			onDone();
		} catch (err) {
			applyServerIssues(form, err);
		}
	});
	const e = form.formState.errors as Record<
		string,
		{ message?: string } | undefined
	> & { auth_config?: Record<string, { message?: string }> };
	return (
		<DirtyFormGuard dirty={form.formState.isDirty}>
			{(requestClose) => (
				<Dialog open onOpenChange={(o) => !o && requestClose(onDone)}>
					<DialogContent className="max-w-xl">
						<DialogHeader>
							<DialogTitle>{editing ? "Edit source" : "New source"}</DialogTitle>
						</DialogHeader>
						<form onSubmit={submit} className="space-y-3">
							<FormSection
								title="Target"
								description="Changes take up to 30 seconds to reach ingress."
							>
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
												onChange={(v) => {
													field.onChange(v);
													form.setValue("destination_id", undefined);
												}}
											/>
										)}
										/>
										<FieldError message={e.project_id?.message} />
									</div>
								)}
								<div>
									<Label>Destination</Label>
									<Controller
										control={form.control}
										name="destination_id"
										render={({ field }) => (
										<ResourcePicker
											kind="destination"
											projectId={projectId}
											label="Destination"
											value={field.value}
											onChange={field.onChange}
										/>
									)}
									/>
									<FieldError message={e.destination_id?.message} />
								</div>
								<div>
									<Label htmlFor="src-name">Name</Label>
									<Input id="src-name" {...form.register("name")} />
									<FieldError message={e.name?.message} />
								</div>
							</FormSection>
							<FormSection title="Authentication">
								{!editing && (
									<div>
										<Label htmlFor="src-auth">Auth type</Label>
										<SimpleSelect
											id="src-auth"
											label="Auth type"
											value={authType}
											onChange={(v) => setAuthType(v as Values["auth_type"])}
											options={AUTH_TYPES.map((t) => [t, AUTH_LABEL[t]])}
										/>
									</div>
								)}
								{authType === "hmac" && (
									<div className="grid grid-cols-2 gap-3">
										<div>
											<Label htmlFor="src-hmac-header">Signature header</Label>
											<Input
												id="src-hmac-header"
												{...form.register("auth_config.header")}
											/>
											<FieldError message={e.auth_config?.header?.message} />
										</div>
										<div>
											<Label htmlFor="src-hmac-prefix">Prefix (optional)</Label>
											<Input
												id="src-hmac-prefix"
												placeholder="sha256="
												{...form.register("auth_config.prefix", {
													setValueAs: (v) => (v === "" ? undefined : v),
												})}
											/>
										</div>
										<div>
											<Label htmlFor="src-hmac-alg">Algorithm</Label>
											<Controller
												control={form.control}
												name="auth_config.algorithm"
												render={({ field }) => (
													<SimpleSelect
														id="src-hmac-alg"
														label="Algorithm"
														value={field.value as string}
														onChange={field.onChange}
														options={[
															["sha256", "SHA-256"],
															["sha512", "SHA-512"],
															["sha1", "SHA-1"],
														]}
													/>
												)}
											/>
										</div>
										<div>
											<Label htmlFor="src-hmac-enc">Encoding</Label>
											<Controller
												control={form.control}
												name="auth_config.encoding"
												render={({ field }) => (
													<SimpleSelect
														id="src-hmac-enc"
														label="Encoding"
														value={field.value as string}
														onChange={field.onChange}
														options={[
															["hex", "hex"],
															["base64", "base64"],
														]}
													/>
												)}
											/>
										</div>
									</div>
								)}
								{authType === "token" && (
									<div className="grid grid-cols-2 gap-3">
										<div>
											<Label htmlFor="src-token-in">Token in</Label>
											<Controller
												control={form.control}
												name="auth_config.in"
												render={({ field }) => (
													<SimpleSelect
														id="src-token-in"
														label="Token in"
														value={field.value as string}
														onChange={field.onChange}
														options={[
															["header", "Header"],
															["query", "Query parameter"],
														]}
													/>
												)}
											/>
										</div>
										<div>
											<Label htmlFor="src-token-name">Name</Label>
											<Input
												id="src-token-name"
												{...form.register("auth_config.name")}
											/>
											<FieldError message={e.auth_config?.name?.message} />
										</div>
									</div>
								)}
								{!editing && authType !== "none" && (
									<div>
										<Label htmlFor="src-secret">
											Secret (optional; leave empty to generate)
										</Label>
										<Input
											id="src-secret"
											autoComplete="off"
											{...form.register("secret", {
												setValueAs: (v) => (v === "" ? undefined : v),
											})}
										/>
										<FieldError message={e.secret?.message} />
									</div>
								)}
							</FormSection>
							<FormSection title="Event ID">
								<div className="grid grid-cols-2 gap-3">
									<div>
										<Label htmlFor="src-eid">Event ID from</Label>
										<Controller
											control={form.control}
											name="event_id_from"
											render={({ field }) => (
											<SimpleSelect
												id="src-eid"
												label="Event ID from"
												value={field.value}
												onChange={field.onChange}
												options={EVENT_ID_FROM.map((v) => [
													v,
													EVENT_ID_LABEL[v],
												])}
											/>
										)}
										/>
									</div>
									{eventFrom !== "none" && (
										<div>
											<Label htmlFor="src-eid-sel">
												{eventFrom === "header" ? "Header name" : "JSON path"}
											</Label>
											<Input
												id="src-eid-sel"
												placeholder={eventFrom === "header" ? "X-Event-Id" : "$.id"}
												{...form.register("event_id_selector")}
											/>
											<FieldError
												message={
													e.event_id_selector?.message &&
													`selector: ${e.event_id_selector.message}`
												}
											/>
										</div>
									)}
								</div>
							</FormSection>
							<FormSection title="Limits">
								<div>
									<Label htmlFor="src-max">Max body bytes (empty = default)</Label>
									<Input
										id="src-max"
										type="number"
										{...form.register(
											"max_body_bytes",
											editing ? nullableNumber : optionalNumber,
										)}
									/>
									<FieldError message={e.max_body_bytes?.message} />
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
