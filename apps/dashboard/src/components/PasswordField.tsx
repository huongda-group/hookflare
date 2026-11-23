import { cn } from "cn";
import { type ComponentProps, type ReactNode, useState } from "react";
import { FormField } from "@/components/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type PasswordInputProps = Omit<ComponentProps<"input">, "type"> & {
	shown: boolean;
};

export type PasswordFieldProps = Omit<PasswordInputProps, "shown" | "id"> & {
	label: string;
	id: string;
	children?: ReactNode;
};

export function PasswordInput({
	shown,
	className,
	...props
}: PasswordInputProps) {
	return (
		<Input
			type={shown ? "text" : "password"}
			className={cn("pr-16", className)}
			{...props}
		/>
	);
}

export function PasswordVisibilityButton({
	id,
	label,
	shown,
	onToggle,
	className,
}: {
	id: string;
	label: string;
	shown: boolean;
	onToggle: () => void;
	className?: string;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			aria-controls={id}
			aria-label={shown ? `Hide ${label}` : `Show ${label}`}
			aria-pressed={shown}
			onClick={onToggle}
			className={cn(
				"group absolute top-1/2 right-1 h-11 w-14 -translate-y-1/2 px-0 hover:bg-transparent focus-visible:outline-none",
				className,
			)}
		>
			<span className="grid h-8 w-full place-items-center rounded-md transition-colors group-hover:bg-accent group-focus-visible:outline-2 group-focus-visible:outline-ring">
				{shown ? "Hide" : "Show"}
			</span>
		</Button>
	);
}

export function PasswordField({
	label,
	id,
	children,
	...props
}: PasswordFieldProps) {
	const [shown, setShown] = useState(false);
	return (
		<FormField htmlFor={id} label={label}>
			<div className="relative">
				<PasswordInput id={id} shown={shown} {...props} />
				<PasswordVisibilityButton
					id={id}
					label={label}
					shown={shown}
					onToggle={() => setShown((s) => !s)}
				/>
			</div>
			{children}
		</FormField>
	);
}
