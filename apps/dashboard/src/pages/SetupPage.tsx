import { setupRequest } from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
	AuthLayout,
	focusFirstInvalidField,
} from "@/components/AuthLayout";
import { PasswordField } from "@/components/PasswordField";
import { FieldError } from "@/components/ProjectFormDialog";
import { TurnstileWidget } from "@/components/TurnstileWidget";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { applyServerIssues } from "@/lib/forms";
import { authStateQuery, setup } from "@/lib/queries/auth";
import { qk } from "@/lib/queries/keys";

/** The confirm field never leaves the client; the server schema stays strict. */
const setupForm = setupRequest
	.extend({ confirm: z.string() })
	.refine((value) => value.password === value.confirm, {
		path: ["confirm"],
		message: "Passwords do not match",
	});

const FIELD_IDS: Record<string, string> = {
	username: "setup-username",
	password: "setup-password",
	confirm: "setup-confirm",
};

export function SetupPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const {
		data: state,
		isPending: authPending,
		isError: authFailed,
		refetch: refetchAuth,
		isFetching: authRefetching,
	} = useQuery(authStateQuery);
	const siteKey = state?.turnstile_site_key ?? null;
	const [token, setToken] = useState<string | null>(null);
	const [resetKey, setResetKey] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const form = useForm<
		z.input<typeof setupForm>,
		unknown,
		z.output<typeof setupForm>
	>({
		resolver: zodResolver(setupForm),
		defaultValues: { username: "", password: "", confirm: "" },
	});
	const errors = form.formState.errors;
	const submit = form.handleSubmit(
		async (values) => {
			setError(null);
			// Drop any root error from a previous attempt so only the latest shows.
			form.clearErrors("root");
			try {
				await setup({
					username: values.username,
					password: values.password,
					turnstile_token: token ?? undefined,
				});
				// Onboarding is closed now: let the root loader see the new state.
				await qc.invalidateQueries({ queryKey: qk.authState });
				await navigate({ to: "/" });
			} catch (err) {
				// Turnstile tokens are single-use: drop it and reset the widget.
				setToken(null);
				setResetKey((k) => k + 1);
				if (err instanceof ApiError && err.status === 409) {
					await qc.invalidateQueries({ queryKey: qk.authState });
					await navigate({ to: "/login" });
				} else if (err instanceof ApiError && err.status === 429) {
					setError("Too many attempts, try again in a minute");
				} else {
					applyServerIssues(form, err);
				}
			}
		},
		(submitErrors) => {
			focusFirstInvalidField(FIELD_IDS, (name) => name in submitErrors);
		},
	);
	const blocked = authPending || authFailed;
	return (
		<AuthLayout
			title="Set up your instance"
			description="Create the first administrator account to get started."
		>
			{authPending ? <p role="status">Loading…</p> : null}
			{authFailed ? (
				<div
					role="alert"
					className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-failure-surface px-4 py-3 text-sm text-failure"
				>
					<p>Could not load setup state. Check your connection.</p>
					<Button
						variant="outline"
						disabled={authRefetching}
						onClick={() => void refetchAuth()}
					>
						Retry
					</Button>
				</div>
			) : null}
			<form onSubmit={submit} className="space-y-4">
				<div>
					<Label htmlFor="setup-username">Username</Label>
					<Input
						id="setup-username"
						autoComplete="username"
						aria-describedby={
							errors.username
								? "setup-username-help setup-username-error"
								: "setup-username-help"
						}
						{...form.register("username")}
					/>
					<p
						id="setup-username-help"
						className="mt-1 text-sm text-muted-foreground"
					>
						3–64 characters: lowercase letters, numbers, and . _ @ + -
					</p>
					<FieldError
						id="setup-username-error"
						message={errors.username?.message}
					/>
				</div>
				<div>
					<PasswordField
						id="setup-password"
						label="Password"
						autoComplete="new-password"
						aria-describedby={
							errors.password
								? "setup-password-help setup-password-error"
								: "setup-password-help"
						}
						{...form.register("password")}
					/>
					<p
						id="setup-password-help"
						className="mt-1 text-sm text-muted-foreground"
					>
						12–256 characters. Leading and trailing spaces are kept.
					</p>
					<FieldError
						id="setup-password-error"
						message={errors.password?.message}
					/>
				</div>
				<div>
					<PasswordField
						id="setup-confirm"
						label="Confirm password"
						autoComplete="new-password"
						aria-describedby={
							errors.confirm ? "setup-confirm-error" : undefined
						}
						{...form.register("confirm")}
					/>
					<FieldError id="setup-confirm-error" message={errors.confirm?.message} />
				</div>
				{blocked ? null : (
					<TurnstileWidget
						siteKey={siteKey}
						action="setup"
						onToken={setToken}
						resetKey={resetKey}
					/>
				)}
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				<FieldError message={errors.root?.message} />
				<Button
					type="submit"
					className="w-full"
					disabled={
						form.formState.isSubmitting ||
						blocked ||
						(siteKey !== null && token === null)
					}
				>
					{form.formState.isSubmitting
						? "Creating account…"
						: "Create admin account"}
				</Button>
			</form>
		</AuthLayout>
	);
}
