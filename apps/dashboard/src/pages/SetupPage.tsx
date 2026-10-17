import { setupRequest } from "@hookflare/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { authStateQuery, setup } from "@/lib/queries/auth";
import { qk } from "@/lib/queries/keys";

/** The confirm field never leaves the client; the server schema stays strict. */
const setupForm = setupRequest
	.extend({ confirm: z.string() })
	.refine((value) => value.password === value.confirm, {
		path: ["confirm"],
		message: "Passwords do not match",
	});

export function SetupPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { data: state } = useQuery(authStateQuery);
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
		defaultValues: { username: "", password: "", confirm: "", setup_token: "" },
	});
	const submit = form.handleSubmit(async (values) => {
		setError(null);
		try {
			await setup({
				username: values.username,
				password: values.password,
				setup_token: values.setup_token,
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
	});
	return (
		<main className="mx-auto mt-24 w-full max-w-sm px-4">
			<Card>
				<CardHeader>
					<CardTitle>Create the first admin</CardTitle>
					<CardDescription>
						This account owns Hookflare. Keep its password safe.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={submit} className="space-y-3">
						<div>
							<Label htmlFor="setup-username">Username</Label>
							<Input
								id="setup-username"
								autoComplete="username"
								{...form.register("username")}
							/>
							<FieldError message={form.formState.errors.username?.message} />
						</div>
						<div>
							<Label htmlFor="setup-password">Password</Label>
							<Input
								id="setup-password"
								type="password"
								autoComplete="new-password"
								{...form.register("password")}
							/>
							<FieldError message={form.formState.errors.password?.message} />
						</div>
						<div>
							<Label htmlFor="setup-confirm">Confirm password</Label>
							<Input
								id="setup-confirm"
								type="password"
								autoComplete="new-password"
								{...form.register("confirm")}
							/>
							<FieldError message={form.formState.errors.confirm?.message} />
						</div>
						<div>
							<Label htmlFor="setup-token">Setup token</Label>
							<Input id="setup-token" {...form.register("setup_token")} />
							<FieldError
								message={form.formState.errors.setup_token?.message}
							/>
						</div>
						<TurnstileWidget
							siteKey={siteKey}
							action="setup"
							onToken={setToken}
							resetKey={resetKey}
						/>
						{error && (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}
						<Button
							type="submit"
							className="w-full"
							disabled={
								form.formState.isSubmitting ||
								(siteKey !== null && token === null)
							}
						>
							Create admin
						</Button>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}
