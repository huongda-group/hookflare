import type { Source } from "@hookflare/shared";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RotateSecretDialog } from "@/components/RotateSecretDialog";
import { SecretRevealDialog } from "@/components/SecretRevealDialog";
import { SourceFormDialog } from "@/components/SourceFormDialog";
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

export function SourceActions({ source: s }: { source: Source }) {
	const qc = useQueryClient();
	const [open, setOpen] = useState<null | "edit" | "rotate" | "toggle">(null);
	const [secret, setSecret] = useState<string | null>(null);
	if (!useCan("config.write")) return null;
	const close = (o: boolean) => {
		if (!o) setOpen(null);
	};
	const next = s.status === "active" ? "disabled" : "active";
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
					<DropdownMenuItem onSelect={() => setOpen("edit")}>
						Edit
					</DropdownMenuItem>
					{s.auth_type !== "none" && (
						<DropdownMenuItem onSelect={() => setOpen("rotate")}>
							Rotate secret
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onSelect={() => setOpen("toggle")}>
						{next === "disabled" ? "Disable" : "Enable"}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{open === "edit" && (
				<SourceFormDialog open onOpenChange={close} source={s} />
			)}
			<RotateSecretDialog
				open={open === "rotate"}
				onOpenChange={close}
				resource="source"
				id={s.id}
				onRotated={setSecret}
			/>
			<SecretRevealDialog
				secret={secret}
				label="New source secret"
				onClose={() => setSecret(null)}
			/>
			<ConfirmDialog
				open={open === "toggle"}
				onOpenChange={close}
				title={`${next === "disabled" ? "Disable" : "Enable"} ${s.name}?`}
				description={
					next === "disabled"
						? "Ingress for this source stops accepting events."
						: "Ingress accepts events again."
				}
				confirmLabel={next === "disabled" ? "Disable" : "Enable"}
				destructive={next === "disabled"}
				onConfirm={async (reason) => {
					await api.patch(`/sources/${s.id}`, { status: next, reason });
					await qc.invalidateQueries({ queryKey: qk.sources.all });
				}}
			/>
		</div>
	);
}
