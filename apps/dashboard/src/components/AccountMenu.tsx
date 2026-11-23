import { ChevronDown, KeyRound, LogOut } from "lucide-react";
import { type JSX, useRef, useState } from "react";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AccountMenu({
	username,
	role,
	canChangePassword,
	onLogout,
}: {
	username: string;
	role: string;
	canChangePassword: boolean;
	onLogout: () => Promise<void>;
}): JSX.Element {
	const trigger = useRef<HTMLButtonElement>(null);
	const [passwordOpen, setPasswordOpen] = useState(false);
	const [logoutOpen, setLogoutOpen] = useState(false);
	const restoreAccountFocus = (event: Event) => {
		event.preventDefault();
		trigger.current?.focus();
	};
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						ref={trigger}
						variant="ghost"
						className="ml-auto h-10 gap-2 px-2"
						aria-label={`Account: ${username}, ${role}`}
						title={username}
					>
						<span
							aria-hidden="true"
							className="grid size-8 shrink-0 place-items-center rounded-full bg-avatar text-xs font-semibold text-avatar-foreground"
						>
							{username.slice(0, 2).toUpperCase()}
						</span>
						<span className="hidden min-w-0 max-w-24 text-left min-[400px]:block sm:max-w-40">
							<span className="block truncate text-xs font-semibold">
								{username}
							</span>
							<span className="block text-[11px] text-muted-foreground capitalize">
								{role}
							</span>
						</span>
						<ChevronDown className="text-muted-foreground" aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					onCloseAutoFocus={(event) => {
						if (passwordOpen || logoutOpen) event.preventDefault();
					}}
				>
					{canChangePassword && (
						<DropdownMenuItem onSelect={() => setPasswordOpen(true)}>
							<KeyRound aria-hidden="true" />
							Change password
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onSelect={() => setLogoutOpen(true)}>
						<LogOut aria-hidden="true" />
						Log out
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{canChangePassword && (
				<ChangePasswordDialog
					open={passwordOpen}
					onOpenChange={setPasswordOpen}
					onCloseAutoFocus={restoreAccountFocus}
				/>
			)}
			<ConfirmDialog
				open={logoutOpen}
				onOpenChange={setLogoutOpen}
				onCloseAutoFocus={restoreAccountFocus}
				title="Log out?"
				description="You’ll need to sign in again to access the dashboard."
				confirmLabel="Log out"
				showReason={false}
				onConfirm={onLogout}
			/>
		</>
	);
}
