import { loginRequest } from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FieldError } from "@/components/ProjectFormDialog";
import { TurnstileWidget } from "@/components/TurnstileWidget";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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

export function LoginPage({ next }: { next?: string }) {
	const navigate = useNavigate();
	const { data: state } = useQuery(authStateQuery);
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
	const submit = form.handleSubmit(async (values) => {
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
	});
	return (
		<main className="mx-auto mt-24 w-full max-w-sm px-4">
			<Card>
				<CardHeader>
					<CardTitle>Sign in</CardTitle>
					<CardDescription>Hookflare administration</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={submit} className="space-y-3">
						<div>
							<Label htmlFor="login-username">Username</Label>
							<Input
								id="login-username"
								autoComplete="username"
								{...form.register("username")}
							/>
							<FieldError message={form.formState.errors.username?.message} />
						</div>
						<div>
							<Label htmlFor="login-password">Password</Label>
							<Input
								id="login-password"
								type="password"
								autoComplete="current-password"
								{...form.register("password")}
							/>
							<FieldError message={form.formState.errors.password?.message} />
						</div>
						<TurnstileWidget
							siteKey={siteKey}
							action="login"
							onToken={setToken}
							resetKey={resetKey}
						/>
						{error && (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}
						<FieldError message={form.formState.errors.root?.message} />
						<Button
							type="submit"
							className="w-full"
							disabled={
								form.formState.isSubmitting ||
								(siteKey !== null && token === null)
							}
						>
							Sign in
						</Button>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}
