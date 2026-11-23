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
import { DirtyFormGuard } from "@/components/DirtyFormGuard";
import { FormField } from "@/components/FormField";
import { FormSection } from "@/components/FormSection";
import { ResourcePicker } from "@/components/ResourcePicker";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api, projectScopedPath } from "@/lib/api";
import { applyServerIssues, nullableNumber, optionalNumber } from "@/lib/forms";
import { invalidateEndpointViews } from "@/lib/queries/invalidate-endpoint-views";
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
	projectId,
	source,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	projectId: string;
	source?: Source;
	onCreated?: (secret: string | null) => void;
}) {
	// Unmount on close so every open starts from the current source.
	if (!open) return null;
	return (
		<SourceForm
			projectId={projectId}
			source={source}
			onDone={() => onOpenChange(false)}
			onCreated={onCreated}
		/>
	);
}

function SourceForm({
	projectId,
	source,
	onDone,
	onCreated,
}: {
	projectId: string;
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
			: {
					project_id: projectId,
					name: "",
					auth_type: "none",
					auth_config: {},
					event_id_from: "none",
				},
	});
	const watchedAuthType = form.watch("auth_type");
	const authType = editing ? source.auth_type : watchedAuthType;
	const eventFrom = form.watch("event_id_from");

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
				await api.patch(
					projectScopedPath(`/sources/${source.id}`, projectId),
					patch,
				);
			} else {
				const res = await api.post<{ secret?: string }>(
					projectScopedPath("/sources", projectId),
					body,
				);
				onCreated?.(res.secret ?? null);
			}
			await invalidateEndpointViews(qc, "source", projectId);
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
							<DialogTitle>
								{editing ? "Edit source" : "New source"}
							</DialogTitle>
						</DialogHeader>
						<form onSubmit={submit} className="space-y-3">
							<FormSection
								title="Target"
								description="Changes take up to 30 seconds to reach ingress."
							>
								<FormField htmlFor="src-destination" label="Destination">
									<Controller
										control={form.control}
										name="destination_id"
										render={({ field }) => (
											<ResourcePicker
												id="src-destination"
												kind="destination"
												projectId={projectId}
												label="Destination"
												value={field.value}
												onChange={field.onChange}
											/>
										)}
									/>
									<FieldError message={e.destination_id?.message} />
								</FormField>
								<FormField htmlFor="src-name" label="Name">
									<Input id="src-name" {...form.register("name")} />
									<FieldError message={e.name?.message} />
								</FormField>
							</FormSection>
							<FormSection title="Authentication">
								{!editing && (
									<FormField htmlFor="src-auth" label="Auth type">
										<SimpleSelect
											id="src-auth"
											label="Auth type"
											value={authType}
											onChange={(v) => setAuthType(v as Values["auth_type"])}
											options={AUTH_TYPES.map((t) => [t, AUTH_LABEL[t]])}
										/>
									</FormField>
								)}
								{authType === "hmac" && (
									<div className="grid grid-cols-2 gap-3">
										<FormField
											htmlFor="src-hmac-header"
											label="Signature header"
										>
											<Input
												id="src-hmac-header"
												{...form.register("auth_config.header")}
											/>
											<FieldError message={e.auth_config?.header?.message} />
										</FormField>
										<FormField
											htmlFor="src-hmac-prefix"
											label="Prefix (optional)"
										>
											<Input
												id="src-hmac-prefix"
												placeholder="sha256="
												{...form.register("auth_config.prefix", {
													setValueAs: (v) => (v === "" ? undefined : v),
												})}
											/>
										</FormField>
										<FormField htmlFor="src-hmac-alg" label="Algorithm">
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
										</FormField>
										<FormField htmlFor="src-hmac-enc" label="Encoding">
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
										</FormField>
									</div>
								)}
								{authType === "token" && (
									<div className="grid grid-cols-2 gap-3">
										<FormField htmlFor="src-token-in" label="Token in">
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
										</FormField>
										<FormField htmlFor="src-token-name" label="Name">
											<Input
												id="src-token-name"
												{...form.register("auth_config.name")}
											/>
											<FieldError message={e.auth_config?.name?.message} />
										</FormField>
									</div>
								)}
								{!editing && authType !== "none" && (
									<FormField
										htmlFor="src-secret"
										label="Secret (optional; leave empty to generate)"
									>
										<Input
											id="src-secret"
											autoComplete="off"
											{...form.register("secret", {
												setValueAs: (v) => (v === "" ? undefined : v),
											})}
										/>
										<FieldError message={e.secret?.message} />
									</FormField>
								)}
							</FormSection>
							<FormSection title="Event ID">
								<div className="grid grid-cols-2 gap-3">
									<FormField htmlFor="src-eid" label="Event ID from">
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
									</FormField>
									{eventFrom !== "none" && (
										<FormField
											htmlFor="src-eid-sel"
											label={
												eventFrom === "header" ? "Header name" : "JSON path"
											}
										>
											<Input
												id="src-eid-sel"
												placeholder={
													eventFrom === "header" ? "X-Event-Id" : "$.id"
												}
												{...form.register("event_id_selector")}
											/>
											<FieldError
												message={
													e.event_id_selector?.message &&
													`selector: ${e.event_id_selector.message}`
												}
											/>
										</FormField>
									)}
								</div>
							</FormSection>
							<FormSection title="Limits">
								<FormField
									htmlFor="src-max"
									label="Max body bytes (empty = default)"
								>
									<Input
										id="src-max"
										type="number"
										{...form.register(
											"max_body_bytes",
											editing ? nullableNumber : optionalNumber,
										)}
									/>
									<FieldError message={e.max_body_bytes?.message} />
								</FormField>
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
