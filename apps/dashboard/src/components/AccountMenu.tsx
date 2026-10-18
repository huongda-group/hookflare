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
		<div className="border-t border-border pt-4">
			<p className="truncate text-sm font-medium text-foreground">{username}</p>
			<p className="text-xs text-muted-foreground capitalize">{role}</p>
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
