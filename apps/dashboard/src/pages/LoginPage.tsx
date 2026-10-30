import { loginRequest } from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AuthLayout, focusFirstInvalidField } from "@/components/AuthLayout";
import { PasswordField } from "@/components/PasswordField";
import { FieldError } from "@/components/ProjectFormDialog";
import { TurnstileWidget } from "@/components/TurnstileWidget";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { applyServerIssues } from "@/lib/forms";
import { safeNext } from "@/lib/next";
import { authStateQuery, login } from "@/lib/queries/auth";

export const loginSearch = z.object({
	next: z.string().optional().catch(undefined),
});
export type LoginSearch = z.infer<typeof loginSearch>;

const FIELD_IDS: Record<string, string> = {
	username: "login-username",
	password: "login-password",
};

export function LoginPage({ next }: { next?: string }) {
	const navigate = useNavigate();
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
		z.input<typeof loginRequest>,
		unknown,
		z.output<typeof loginRequest>
	>({
		resolver: zodResolver(loginRequest),
		defaultValues: { username: "", password: "" },
	});
	const errors = form.formState.errors;
	const submit = form.handleSubmit(
		async (values) => {
			setError(null);
			// Drop any root error from a previous attempt so only the latest shows.
			form.clearErrors("root");
			try {
				await login({ ...values, turnstile_token: token ?? undefined });
				await navigate({ href: safeNext(next) });
			} catch (err) {
				// Turnstile tokens are single-use: drop it and reset the widget.
				setToken(null);
				setResetKey((k) => k + 1);
				if (err instanceof ApiError && err.status === 401) {
					setError("Invalid username or password");
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
			title="Sign in to Hookflare"
			description="Welcome back — sign in to manage webhook delivery."
		>
			{authPending ? <p role="status">Loading…</p> : null}
			{authFailed ? (
				<div
					role="alert"
					className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-failure-surface px-4 py-3 text-sm text-failure"
				>
					<p>Could not load sign-in state. Check your connection.</p>
					<Button
						variant="outline"
						disabled={authRefetching}
						onClick={() => void refetchAuth()}
					>
						Retry
					</Button>
				</div>
			) : null}
			<form onSubmit={submit} className="space-y-5">
				<div className="space-y-2">
					<Label htmlFor="login-username">Username</Label>
					<Input
						id="login-username"
						autoComplete="username"
						{...form.register("username")}
					/>
					<FieldError message={errors.username?.message} />
				</div>
				<div className="space-y-2">
					<PasswordField
						id="login-password"
						label="Password"
						autoComplete="current-password"
						{...form.register("password")}
					/>
					<FieldError message={errors.password?.message} />
				</div>
				{blocked ? null : (
					<TurnstileWidget
						siteKey={siteKey}
						action="login"
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
					className="mt-2 h-11 w-full"
					disabled={
						form.formState.isSubmitting ||
						blocked ||
						(siteKey !== null && token === null)
					}
				>
					{form.formState.isSubmitting ? "Signing in…" : "Sign in"}
				</Button>
			</form>
		</AuthLayout>
	);
}
