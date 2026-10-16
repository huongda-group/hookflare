import { type Page, ROLES, type Role, type User } from "@hookflare/shared";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CursorTable } from "@/components/CursorTable";
import { TimeText } from "@/components/TimeText";
import { Button } from "@/components/ui/button";
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
	email: string;
	body: { role?: Role; disabled?: boolean };
	title: string;
	label: string;
};

export function UsersTab() {
	const qc = useQueryClient();
	const me = useMe();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>("viewer");
	const [addError, setAddError] = useState<string | null>(null);
	const [pending, setPending] = useState<Pending | null>(null);
	const query = useInfiniteQuery({
		queryKey: qk.users.all,
		queryFn: ({ pageParam }) =>
			api.get<Page<User>>("/users", { limit: 50, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
	const refresh = () => qc.invalidateQueries({ queryKey: qk.users.all });
	const add = async () => {
		setAddError(null);
		try {
			await api.post("/users", { email: email.trim(), role });
			setEmail("");
			await refresh();
		} catch (err) {
			setAddError(errorText(err));
		}
	};
	return (
		<div className="space-y-4">
			<div className="flex items-end gap-3">
				<div>
					<Label htmlFor="u-email">Email</Label>
					<Input
						id="u-email"
						type="email"
						className="w-72"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
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
				<Button onClick={() => void add()} disabled={!email.trim()}>
					Add user
				</Button>
			</div>
			{addError && <p className="text-sm text-red-700">{addError}</p>}
			<CursorTable<User>
				query={query}
				rowKey={(u) => u.email}
				empty="No users."
				columns={[
					{ header: "Email", cell: (u) => u.email },
					{
						header: "Role",
						cell: (u) => (
							<Select
								value={u.role}
								disabled={u.email === me?.email}
								onValueChange={(v) =>
									setPending({
										email: u.email,
										body: { role: v as Role },
										title: `Change ${u.email} to ${v}?`,
										label: "Change role",
									})
								}
							>
								<SelectTrigger
									className="w-32"
									aria-label={`Role of ${u.email}`}
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
							u.email === me?.email ? null : u.disabled_at ? (
								<Button
									variant="outline"
									size="sm"
									aria-label={`Enable ${u.email}`}
									onClick={() =>
										setPending({
											email: u.email,
											body: { disabled: false },
											title: `Enable ${u.email}?`,
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
									aria-label={`Disable ${u.email}`}
									onClick={() =>
										setPending({
											email: u.email,
											body: { disabled: true },
											title: `Disable ${u.email}?`,
											label: "Disable",
										})
									}
								>
									Disable
								</Button>
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
					await api.patch(`/users/${encodeURIComponent(pending.email)}`, {
						...pending.body,
						...(reason ? { reason } : {}),
					});
					await refresh();
				}}
			/>
		</div>
	);
}
