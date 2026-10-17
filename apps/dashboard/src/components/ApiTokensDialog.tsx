import type { ApiToken, CreatedApiToken } from "@hookflare/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SecretRevealDialog } from "@/components/SecretRevealDialog";
import { TimeText } from "@/components/TimeText";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { errorText } from "@/lib/forms";

const path = (username: string) => `/users/${encodeURIComponent(username)}`;

/** Spec M7 §6.9: admins manage any user's machine tokens from Settings › Users. */
export function ApiTokensDialog({
	username,
	open,
	onOpenChange,
}: {
	username: string;
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const qc = useQueryClient();
	const key = ["users", username, "tokens"] as const;
	const tokens = useQuery({
		queryKey: key,
		// The list never carries secrets; the plaintext is shown once at creation.
		queryFn: () => api.get<{ data: ApiToken[] }>(`${path(username)}/tokens`),
		enabled: open,
	});
	const [name, setName] = useState("");
	const [createError, setCreateError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [secret, setSecret] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<ApiToken | null>(null);

	const refresh = () =>
		qc.invalidateQueries({ queryKey: key, refetchType: "all" });

	const create = async () => {
		setCreating(true);
		setCreateError(null);
		try {
			const created = await api.post<CreatedApiToken>(
				`${path(username)}/tokens`,
				{ name: name.trim() },
			);
			setName("");
			setSecret(created.token);
			await refresh();
		} catch (err) {
			setCreateError(errorText(err));
		} finally {
			setCreating(false);
		}
	};

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-w-lg">
					<DialogHeader>
						<DialogTitle>API tokens for {username}</DialogTitle>
						<DialogDescription>
							Machine access without Turnstile. A token acts as this user until
							it expires or is revoked.
						</DialogDescription>
					</DialogHeader>
					{tokens.data ? (
						tokens.data.data.length === 0 ? (
							<p className="text-sm text-neutral-500">No API tokens yet.</p>
						) : (
							<ul className="space-y-2">
								{tokens.data.data.map((t) => (
									<li
										key={t.id}
										className="flex items-center gap-3 rounded border px-3 py-2 text-sm"
									>
										<div className="min-w-0 flex-1">
											<div className="font-medium">{t.name}</div>
											<div className="text-xs text-neutral-500">
												Created <TimeText ms={t.created_at} />
												{t.expires_at !== null && (
													<>
														{" · "}expires <TimeText ms={t.expires_at} />
													</>
												)}
												{t.revoked_at !== null && " · revoked"}
											</div>
										</div>
										{t.revoked_at === null && (
											<Button
												variant="outline"
												size="sm"
												aria-label={`Revoke token ${t.name}`}
												onClick={() => setRevoking(t)}
											>
												Revoke
											</Button>
										)}
									</li>
								))}
							</ul>
						)
					) : tokens.error ? (
						<p className="text-sm text-red-700">{errorText(tokens.error)}</p>
					) : (
						<p className="text-sm text-neutral-500">Loading…</p>
					)}
					<div className="flex items-end gap-2">
						<div className="flex-1">
							<Label htmlFor="token-name">Token name</Label>
							<Input
								id="token-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>
						<Button
							disabled={creating || !name.trim()}
							onClick={() => void create()}
						>
							Create token
						</Button>
						<Button
							variant="outline"
							onClick={() => void tokens.refetch()}
							disabled={tokens.isFetching}
						>
							Refresh
						</Button>
					</div>
					{createError && <p className="text-sm text-red-700">{createError}</p>}
				</DialogContent>
			</Dialog>
			<SecretRevealDialog
				secret={secret}
				label="API token"
				onClose={() => setSecret(null)}
			/>
			<ConfirmDialog
				open={revoking !== null}
				onOpenChange={(o) => {
					if (!o) setRevoking(null);
				}}
				title={revoking ? `Revoke token ${revoking.name}?` : ""}
				description="Automation using this token stops working immediately."
				confirmLabel="Revoke"
				destructive
				onConfirm={async (reason) => {
					if (!revoking) return;
					await api.postVoid(
						`${path(username)}/tokens/${revoking.id}/revoke`,
						...(reason ? [{ reason }] : []),
					);
					await refresh();
				}}
			/>
		</>
	);
}
