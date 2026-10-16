import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

/** Shown once; the secret lives only in the caller's state and is dropped on close (spec §11). */
export function SecretRevealDialog({
	secret,
	label,
	onClose,
}: {
	secret: string | null;
	label: string;
	onClose: () => void;
}) {
	const [stored, setStored] = useState(false);
	return (
		<Dialog
			open={secret !== null}
			onOpenChange={(o) => {
				if (!o && stored) onClose();
			}}
		>
			<DialogContent
				showCloseButton={stored}
				onEscapeKeyDown={(e) => {
					if (!stored) e.preventDefault();
				}}
				onPointerDownOutside={(e) => {
					if (!stored) e.preventDefault();
				}}
			>
				<DialogHeader>
					<DialogTitle>{label}</DialogTitle>
					<DialogDescription>
						This is the only time it is shown. Store it in your secret manager
						now.
					</DialogDescription>
				</DialogHeader>
				<div className="flex items-center gap-2">
					<code className="flex-1 break-all rounded bg-neutral-100 p-2 text-sm">
						{secret}
					</code>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void navigator.clipboard?.writeText(secret ?? "")}
					>
						Copy
					</Button>
				</div>
				<div className="flex items-center gap-2">
					<Checkbox
						id="secret-stored"
						checked={stored}
						onCheckedChange={(v) => setStored(v === true)}
					/>
					<Label htmlFor="secret-stored">I have stored this secret</Label>
				</div>
				<DialogFooter>
					<Button
						disabled={!stored}
						onClick={() => {
							setStored(false);
							onClose();
						}}
					>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
