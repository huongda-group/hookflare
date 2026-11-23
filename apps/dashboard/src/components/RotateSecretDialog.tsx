import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, projectScopedPath } from "@/lib/api";
import { errorText } from "@/lib/forms";
import { invalidateEndpointViews } from "@/lib/queries/invalidate-endpoint-views";

type Props = {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	resource: "source" | "destination";
	id: string;
	projectId: string;
	/** Shown in the title so rotation confirms what it revokes. */
	name?: string;
	/** The generated secret, or null when the caller supplied one (sources). */
	onRotated: (secret: string | null) => void;
};

export function RotateSecretDialog({ open, onOpenChange, ...rest }: Props) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* DialogContent unmounts when closed, so the form state below resets on every close path. */}
			<DialogContent>
				<RotateSecretForm onOpenChange={onOpenChange} {...rest} />
			</DialogContent>
		</Dialog>
	);
}

function RotateSecretForm({
	onOpenChange,
	resource,
	id,
	projectId,
	name,
	onRotated,
}: Omit<Props, "open">) {
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
				projectScopedPath(`/${resource}s/${id}/rotate-secret`, projectId),
				{
					grace_hours: graceHours,
					...(supplied ? { secret: supplied } : {}),
					...(reason.trim() ? { reason: reason.trim() } : {}),
				},
			),
		onSuccess: (res) => {
			void invalidateEndpointViews(qc, resource, projectId);
			onOpenChange(false);
			onRotated(res.signing_secret ?? res.secret ?? null);
		},
	});
	return (
		<>
			<DialogHeader>
				<DialogTitle>Rotate secret{name ? ` for ${name}` : ""}</DialogTitle>
				<DialogDescription>
					The previous secret keeps working for the grace period.
				</DialogDescription>
			</DialogHeader>
			<FormField htmlFor="grace" label="Grace period (hours)">
				<Input
					id="grace"
					type="number"
					min={0}
					max={168}
					value={grace}
					onChange={(e) => setGrace(e.target.value)}
				/>
				{grace === "0" && (
					<p className="text-sm font-medium text-failure">
						Grace 0 revokes the current secret immediately.
					</p>
				)}
				{!validGrace && (
					<p className="text-sm text-failure">
						Enter a whole number from 0 to 168.
					</p>
				)}
			</FormField>
			{resource === "source" && (
				<FormField
					htmlFor="supplied"
					label="New secret (optional, 16–512 characters; leave empty to generate)"
				>
					<Input
						id="supplied"
						type="password"
						value={supplied}
						onChange={(e) => setSupplied(e.target.value)}
						autoComplete="off"
					/>
				</FormField>
			)}
			<FormField htmlFor="rotate-reason" label="Reason (optional)">
				<Textarea
					id="rotate-reason"
					maxLength={500}
					value={reason}
					onChange={(e) => setReason(e.target.value)}
				/>
			</FormField>
			{m.error && <p className="text-sm text-failure">{errorText(m.error)}</p>}
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
		</>
	);
}
