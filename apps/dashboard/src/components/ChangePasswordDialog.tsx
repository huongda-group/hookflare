import { PASSWORD_MIN_LENGTH } from "@hookflare/shared";
import { useState } from "react";
import { PasswordField } from "@/components/PasswordField";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { errorText } from "@/lib/forms";
import { changePassword } from "@/lib/queries/auth";

export function ChangePasswordDialog({
	open,
	onOpenChange,
	onCloseAutoFocus,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	onCloseAutoFocus: (event: Event) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent onCloseAutoFocus={onCloseAutoFocus}>
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

	const clientError =
		next.length > 0 && next.length < PASSWORD_MIN_LENGTH
			? `New password must be at least ${PASSWORD_MIN_LENGTH} characters`
			: confirm && next !== confirm
				? "Passwords do not match"
				: null;

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
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
			<PasswordField
				id="pw-current"
				label="Current password"
				autoComplete="current-password"
				value={current}
				onChange={(e) => setCurrent(e.target.value)}
			/>
			<PasswordField
				id="pw-new"
				label="New password"
				autoComplete="new-password"
				value={next}
				onChange={(e) => setNext(e.target.value)}
			/>
			<PasswordField
				id="pw-confirm"
				label="Confirm new password"
				autoComplete="new-password"
				value={confirm}
				onChange={(e) => setConfirm(e.target.value)}
			/>
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
