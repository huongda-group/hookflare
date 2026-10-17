import { type Page, ROLES, type Role, type User } from "@hookflare/shared";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiTokensDialog } from "@/components/ApiTokensDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CursorTable } from "@/components/CursorTable";
import { TimeText } from "@/components/TimeText";
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
import { errorText } from "@/lib/forms";
import { useMe } from "@/lib/permissions";
import { qk } from "@/lib/queries/keys";

type Pending = {
	username: string;
	body: { role?: Role; disabled?: boolean };
	title: string;
	label: string;
};

export function UsersTab() {
	const qc = useQueryClient();
	const me = useMe();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<Role>("viewer");
	const [addError, setAddError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [pending, setPending] = useState<Pending | null>(null);
	const [resetUser, setResetUser] = useState<string | null>(null);
	const [tokensUser, setTokensUser] = useState<string | null>(null);
	const query = useInfiniteQuery({
		queryKey: qk.users.all,
		queryFn: ({ pageParam }) =>
			api.get<Page<User>>("/users", { limit: 50, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
	const refresh = () => qc.invalidateQueries({ queryKey: qk.users.all });
	const add = async () => {
		setAdding(true);
		setAddError(null);
		try {
			// The username is normalized like the server schema; the password
			// is never trimmed or otherwise touched (spec M7 §6.2).
			await api.post("/users", {
				username: username.trim().toLowerCase(),
				role,
				password,
			});
			setUsername("");
			setPassword("");
			await refresh();
		} catch (err) {
			setAddError(errorText(err));
		} finally {
			setAdding(false);
		}
	};
	return (
		<div className="space-y-4">
			<div className="flex items-end gap-3">
				<div>
					<Label htmlFor="u-username">Username</Label>
					<Input
						id="u-username"
						className="w-56"
						autoComplete="off"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
					/>
				</div>
				<div>
					<Label htmlFor="u-password">Password</Label>
					<Input
						id="u-password"
						type="password"
						className="w-56"
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</div>
				<Select value={role} onValueChange={(v) => setRole(v as Role)}>
					<SelectTrigger className="w-36" aria-label="Role">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{ROLES.map((r) => (
							<SelectItem key={r} value={r}>
								{r}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Button
					onClick={() => void add()}
					disabled={adding || !username.trim() || !password}
				>
					Add user
				</Button>
			</div>
			{addError && <p className="text-sm text-red-700">{addError}</p>}
			<CursorTable<User>
				query={query}
				rowKey={(u) => u.username}
				empty="No users."
				columns={[
					{
						header: "Username",
						cell: (u) => u.username,
					},
					{
						header: "Role",
						cell: (u) => (
							<Select
								value={u.role}
								disabled={u.username === me?.username}
								onValueChange={(v) =>
									setPending({
										username: u.username,
										body: { role: v as Role },
										title: `Change ${u.username} to ${v}?`,
										label: "Change role",
									})
								}
							>
								<SelectTrigger
									className="w-32"
									aria-label={`Role of ${u.username}`}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ROLES.map((r) => (
										<SelectItem key={r} value={r}>
											{r}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						),
					},
					{
						header: "Status",
						cell: (u) =>
							u.disabled_at ? (
								<span>
									Disabled <TimeText ms={u.disabled_at} />
								</span>
							) : (
								"Active"
							),
					},
					{
						header: "",
						cell: (u) =>
							u.username === me?.username ? null : (
								<div className="flex gap-2">
									<Button
										variant="outline"
										size="sm"
										aria-label={`Reset password for ${u.username}`}
										onClick={() => setResetUser(u.username)}
									>
										Reset password
									</Button>
									<Button
										variant="outline"
										size="sm"
										aria-label={`API tokens for ${u.username}`}
										onClick={() => setTokensUser(u.username)}
									>
										API tokens
									</Button>
									{u.disabled_at ? (
										<Button
											variant="outline"
											size="sm"
											aria-label={`Enable ${u.username}`}
											onClick={() =>
												setPending({
													username: u.username,
													body: { disabled: false },
													title: `Enable ${u.username}?`,
													label: "Enable",
												})
											}
										>
											Enable
										</Button>
									) : (
										<Button
											variant="outline"
											size="sm"
											aria-label={`Disable ${u.username}`}
											onClick={() =>
												setPending({
													username: u.username,
													body: { disabled: true },
													title: `Disable ${u.username}?`,
													label: "Disable",
												})
											}
										>
											Disable
										</Button>
									)}
								</div>
							),
					},
				]}
			/>
			<ConfirmDialog
				open={pending !== null}
				onOpenChange={(o) => {
					if (!o) setPending(null);
				}}
				title={pending?.title ?? ""}
				description="The change applies on the user's next request."
				confirmLabel={pending?.label ?? "Confirm"}
				destructive={pending?.body.disabled === true}
				onConfirm={async (reason) => {
					if (!pending) return;
					await api.patch(`/users/${encodeURIComponent(pending.username)}`, {
						...pending.body,
						...(reason ? { reason } : {}),
					});
					await refresh();
				}}
			/>
			<ResetPasswordDialog
				username={resetUser}
				onOpenChange={(o) => {
					if (!o) setResetUser(null);
				}}
			/>
			{tokensUser !== null && (
				<ApiTokensDialog
					username={tokensUser}
					open
					onOpenChange={(o) => {
						if (!o) setTokensUser(null);
					}}
				/>
			)}
		</div>
	);
}

/** Admin reset: sets the password and signs the user out everywhere (spec M7 §6.6). */
function ResetPasswordDialog({
	username,
	onOpenChange,
}: {
	username: string | null;
	onOpenChange: (o: boolean) => void;
}) {
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(false);
	const reset = async () => {
		if (!username) return;
		setBusy(true);
		setError(null);
		try {
			await api.postVoid(`/users/${encodeURIComponent(username)}/password`, {
				password,
			});
			setSaved(true);
		} catch (err) {
			setError(errorText(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog
			open={username !== null}
			onOpenChange={(o) => {
				if (!o) {
					setPassword("");
					setError(null);
					setSaved(false);
				}
				onOpenChange(o);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Reset password for {username}</DialogTitle>
				</DialogHeader>
				{saved ? (
					<>
						<p className="text-sm">
							The password was reset. {username} was signed out everywhere; hand
							over the new password out of band.
						</p>
						<DialogFooter>
							<Button onClick={() => onOpenChange(false)}>Close</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<div>
							<Label htmlFor="reset-password">New password</Label>
							<Input
								id="reset-password"
								type="password"
								autoComplete="new-password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
							/>
						</div>
						{error && <p className="text-sm text-red-700">{error}</p>}
						<DialogFooter>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button disabled={busy || !password} onClick={() => void reset()}>
								Reset password
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
