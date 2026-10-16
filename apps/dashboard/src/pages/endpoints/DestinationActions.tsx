import type { Destination } from "@hookflare/shared";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DestinationFormDialog } from "@/components/DestinationFormDialog";
import { RotateSecretDialog } from "@/components/RotateSecretDialog";
import { SecretRevealDialog } from "@/components/SecretRevealDialog";
import { TestDeliveryDialog } from "@/components/TestDeliveryDialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { qk } from "@/lib/queries/keys";

type Open = null | "edit" | "pause" | "resume" | "disable" | "test" | "rotate";

export function DestinationActions({
	destination: d,
}: {
	destination: Destination;
}) {
	const qc = useQueryClient();
	const canConfig = useCan("config.write");
	const canOperate = useCan("destinations.operate");
	const [open, setOpen] = useState<Open>(null);
	const [secret, setSecret] = useState<string | null>(null);
	if (!canConfig && !canOperate) return null;
	const close = (o: boolean) => {
		if (!o) setOpen(null);
	};
	const refresh = () => qc.invalidateQueries({ queryKey: qk.destinations.all });
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: only stops clicks and keys from bubbling to the clickable table row; the menu trigger inside is the interactive element.
		<div
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="sm" aria-label="Actions">
						<MoreHorizontal className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{canConfig && (
						<DropdownMenuItem onSelect={() => setOpen("edit")}>
							Edit
						</DropdownMenuItem>
					)}
					{canOperate && d.status === "active" && (
						<DropdownMenuItem onSelect={() => setOpen("pause")}>
							Pause
						</DropdownMenuItem>
					)}
					{canOperate && d.status === "paused" && (
						<DropdownMenuItem onSelect={() => setOpen("resume")}>
							Resume
						</DropdownMenuItem>
					)}
					{canOperate && (
						<DropdownMenuItem onSelect={() => setOpen("test")}>
							Send test
						</DropdownMenuItem>
					)}
					{canConfig && (
						<DropdownMenuItem onSelect={() => setOpen("rotate")}>
							Rotate secret
						</DropdownMenuItem>
					)}
					{canConfig && d.status !== "disabled" && (
						<DropdownMenuItem onSelect={() => setOpen("disable")}>
							Disable
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{open === "edit" && (
				<DestinationFormDialog open onOpenChange={close} destination={d} />
			)}
			<ConfirmDialog
				open={open === "pause"}
				onOpenChange={close}
				title={`Pause ${d.name}?`}
				description="New and retrying deliveries are held as paused until you resume."
				confirmLabel="Pause"
				onConfirm={async (reason) => {
					await api.post(`/destinations/${d.id}/pause`, { reason });
					await refresh();
				}}
			/>
			<ConfirmDialog
				open={open === "resume"}
				onOpenChange={close}
				title={`Resume ${d.name}?`}
				description="Paused deliveries are enqueued again."
				confirmLabel="Resume"
				onConfirm={async (reason) => {
					await api.post(`/destinations/${d.id}/resume`, { reason });
					await refresh();
				}}
			/>
			<ConfirmDialog
				open={open === "disable"}
				onOpenChange={close}
				title={`Disable ${d.name}?`}
				description="Deliveries to a disabled destination are not attempted."
				confirmLabel="Disable"
				destructive
				onConfirm={async (reason) => {
					await api.patch(`/destinations/${d.id}`, {
						status: "disabled",
						reason,
					});
					await refresh();
				}}
			/>
			<TestDeliveryDialog
				open={open === "test"}
				onOpenChange={close}
				destinationId={d.id}
			/>
			<RotateSecretDialog
				open={open === "rotate"}
				onOpenChange={close}
				resource="destination"
				id={d.id}
				onRotated={setSecret}
			/>
			<SecretRevealDialog
				secret={secret}
				label="New signing secret"
				onClose={() => setSecret(null)}
			/>
		</div>
	);
}
