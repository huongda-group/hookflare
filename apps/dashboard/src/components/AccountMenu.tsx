import { KeyRound, LogOut } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";

/**
 * The account block at the sidebar bottom (spec §6): a visible block, not a
 * popup menu, so both actions stay reachable in one tap on touch and keep
 * their exact accessible names. Password change is available to every role.
 */
export function AccountMenu({
	username,
	role,
	onChangePassword,
	onLogout,
}: {
	username: string;
	role: string;
	onChangePassword: () => void;
	onLogout: () => void;
}): JSX.Element {
	return (
		<div className="min-w-0 border-t border-border pt-4">
			<div className="flex min-w-0 items-center gap-2.5 px-1">
				<span
					aria-hidden="true"
					className="grid size-8 shrink-0 place-items-center rounded-full bg-avatar text-xs font-semibold text-avatar-foreground"
				>
					{username.slice(0, 2).toUpperCase()}
				</span>
				<div className="min-w-0">
					<p
						className="truncate text-xs font-semibold text-foreground"
						title={username}
					>
						{username}
					</p>
					<p className="text-[11px] text-muted-foreground capitalize">{role}</p>
				</div>
			</div>
			<div className="mt-2 flex flex-col items-stretch gap-1">
				<Button
					variant="ghost"
					size="sm"
					className="justify-start"
					onClick={onChangePassword}
				>
					<KeyRound aria-hidden="true" />
					Change password
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="justify-start"
					onClick={onLogout}
				>
					<LogOut aria-hidden="true" />
					Log out
				</Button>
			</div>
		</div>
	);
}
