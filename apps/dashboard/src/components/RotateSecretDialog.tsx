import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { errorText } from "@/lib/forms";

type Props = {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	resource: "source" | "destination";
	id: string;
	/** The generated secret, or null when the caller supplied one (sources). */
	onRotated: (secret: string | null) => void;
};

export function RotateSecretDialog({
	open,
	onOpenChange,
	resource,
	id,
	onRotated,
}: Props) {
	const qc = useQueryClient();
	const [grace, setGrace] = useState("24");
	const [supplied, setSupplied] = useState("");
	const [reason, setReason] = useState("");
	const graceHours = Number(grace);
	const validGrace =
		grace !== "" &&
		Number.isInteger(graceHours) &&
		graceHours >= 0 &&
		graceHours <= 168;
	const m = useMutation({
		mutationFn: () =>
			api.post<{ signing_secret?: string; secret?: string }>(
				`/${resource}s/${id}/rotate-secret`,
				{
					grace_hours: graceHours,
					...(supplied ? { secret: supplied } : {}),
					...(reason.trim() ? { reason: reason.trim() } : {}),
				},
			),
		onSuccess: (res) => {
			void qc.invalidateQueries({ queryKey: [`${resource}s`] });
			onOpenChange(false);
			onRotated(res.signing_secret ?? res.secret ?? null);
		},
	});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Rotate secret</DialogTitle>
					<DialogDescription>
						The previous secret keeps working for the grace period.
					</DialogDescription>
				</DialogHeader>
				<Label htmlFor="grace">Grace period (hours)</Label>
				<Input
					id="grace"
					type="number"
					min={0}
					max={168}
					value={grace}
					onChange={(e) => setGrace(e.target.value)}
				/>
				{grace === "0" && (
					<p className="text-sm font-medium text-red-700">
						Grace 0 revokes the current secret immediately.
					</p>
				)}
				{!validGrace && (
					<p className="text-sm text-red-700">
						Enter a whole number from 0 to 168.
					</p>
				)}
				{resource === "source" && (
					<>
						<Label htmlFor="supplied">
							New secret (optional, 16–512 characters; leave empty to generate)
						</Label>
						<Input
							id="supplied"
							value={supplied}
							onChange={(e) => setSupplied(e.target.value)}
							autoComplete="off"
						/>
					</>
				)}
				<Label htmlFor="rotate-reason">Reason (optional)</Label>
				<Textarea
					id="rotate-reason"
					maxLength={500}
					value={reason}
					onChange={(e) => setReason(e.target.value)}
				/>
				{m.error && (
					<p className="text-sm text-red-700">{errorText(m.error)}</p>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						disabled={!validGrace || m.isPending}
						onClick={() => m.mutate()}
					>
						Rotate
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
