import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/forms";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	confirmLabel: string;
	destructive?: boolean;
	onConfirm: (reason?: string) => Promise<unknown>;
};

/** Disable, Pause, role changes: an optional reason goes to the audit log. */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	destructive,
	onConfirm,
}: Props) {
	const [reason, setReason] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<Label htmlFor="confirm-reason">Reason (optional)</Label>
				<Textarea
					id="confirm-reason"
					maxLength={500}
					value={reason}
					onChange={(e) => setReason(e.target.value)}
				/>
				{error && <p className="text-sm text-red-700">{error}</p>}
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
								setReason("");
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
			</DialogContent>
		</Dialog>
	);
}
