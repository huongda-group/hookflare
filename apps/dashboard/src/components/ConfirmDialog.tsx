import { useState } from "react";
import { FormField } from "@/components/FormField";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/forms";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCloseAutoFocus?: (event: Event) => void;
	title: string;
	description: string;
	confirmLabel: string;
	destructive?: boolean;
	showReason?: boolean;
	onConfirm: (reason?: string) => Promise<unknown>;
};

/** Audited actions can collect an optional reason. */
export function ConfirmDialog({
	open,
	onOpenChange,
	onCloseAutoFocus,
	...rest
}: Props) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* DialogContent unmounts when closed, so the reason below resets on every close path. */}
			<DialogContent onCloseAutoFocus={onCloseAutoFocus}>
				<ConfirmForm onOpenChange={onOpenChange} {...rest} />
			</DialogContent>
		</Dialog>
	);
}

function ConfirmForm({
	onOpenChange,
	title,
	description,
	confirmLabel,
	destructive,
	showReason = true,
	onConfirm,
}: Omit<Props, "open" | "onCloseAutoFocus">) {
	const [reason, setReason] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	return (
		<>
			<DialogHeader>
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription>{description}</DialogDescription>
			</DialogHeader>
			{showReason && (
				<FormField htmlFor="confirm-reason" label="Reason (optional)">
					<Textarea
						id="confirm-reason"
						maxLength={500}
						value={reason}
						onChange={(e) => setReason(e.target.value)}
					/>
				</FormField>
			)}
			{error && <p className="text-sm text-failure">{error}</p>}
			<DialogFooter>
				<Button variant="outline" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button
					variant={destructive ? "destructive" : "default"}
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						setError(null);
						try {
							await onConfirm(reason.trim() || undefined);
							onOpenChange(false);
						} catch (err) {
							setError(errorText(err));
						} finally {
							setBusy(false);
						}
					}}
				>
					{confirmLabel}
				</Button>
			</DialogFooter>
		</>
	);
}
