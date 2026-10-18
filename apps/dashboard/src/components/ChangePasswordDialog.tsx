import { useState } from "react";
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
import { ApiError } from "@/lib/api";
import { errorText } from "@/lib/forms";
import { changePassword } from "@/lib/queries/auth";

/** Spec M7 §6.6: any logged-in user changes their own password here. */
export function ChangePasswordDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* Unmounts on close, so every open starts with empty fields. */}
			<DialogContent>
				<ChangePasswordForm onOpenChange={onOpenChange} />
			</DialogContent>
		</Dialog>
	);
}

function ChangePasswordForm({
	onOpenChange,
}: {
	onOpenChange: (o: boolean) => void;
}) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);

	// Client-side only; the server re-checks length (12–256, never trimmed),
	// equality with the username, and the current password.
	const clientError =
		next.length > 0 && next.length < 12
			? "New password must be at least 12 characters"
			: confirm && next !== confirm
				? "Passwords do not match"
				: null;

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			// Never trimmed: spaces are significant (spec M7 §6.2).
			await changePassword({ current_password: current, new_password: next });
			setSaved(true);
		} catch (err) {
			if (err instanceof ApiError && err.code === "wrong_password") {
				setError("Current password is incorrect");
			} else {
				setError(errorText(err));
			}
		} finally {
			setBusy(false);
		}
	};

	if (saved) {
		return (
			<>
				<DialogHeader>
					<DialogTitle>Password changed</DialogTitle>
				</DialogHeader>
				<p className="text-sm">
					Your password was changed. Other sessions were signed out.
				</p>
				<DialogFooter>
					<Button onClick={() => onOpenChange(false)}>Close</Button>
				</DialogFooter>
			</>
		);
	}

	return (
		<>
			<DialogHeader>
				<DialogTitle>Change password</DialogTitle>
			</DialogHeader>
			<div className="space-y-2">
				<Label htmlFor="pw-current">Current password</Label>
				<Input
					id="pw-current"
					type="password"
					autoComplete="current-password"
					value={current}
					onChange={(e) => setCurrent(e.target.value)}
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="pw-new">New password</Label>
				<Input
					id="pw-new"
					type="password"
					autoComplete="new-password"
					value={next}
					onChange={(e) => setNext(e.target.value)}
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="pw-confirm">Confirm new password</Label>
				<Input
					id="pw-confirm"
					type="password"
					autoComplete="new-password"
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
				/>
			</div>
			{(clientError ?? error) && (
				<p
					data-field-error
					className="rounded-md border border-failure/40 bg-failure-surface px-3 py-2 text-sm text-failure"
				>
					{clientError ?? error}
				</p>
			)}
			<DialogFooter>
				<Button variant="outline" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button
					disabled={
						busy || !current || !next || !confirm || clientError !== null
					}
					onClick={() => void save()}
				>
					Save password
				</Button>
			</DialogFooter>
		</>
	);
}
