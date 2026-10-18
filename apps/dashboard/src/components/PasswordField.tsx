import { useState, type ComponentProps } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PasswordFieldProps = Omit<ComponentProps<"input">, "type" | "id"> & {
	/** Visible label text; also the accessible name for the show/hide toggle. */
	label: string;
	id: string;
};

/**
 * A password input with a deliberate show/hide toggle (spec §8.1–8.2).
 *
 * Toggling only flips the input `type`, so the value, autocomplete, pasted
 * content, and the forwarded ref (react-hook-form) all survive the switch.
 * The toggle is `type="button"` so it never submits the surrounding form,
 * and both states have an explicit accessible name.
 */
export function PasswordField({
	label,
	id,
	className,
	autoComplete,
	...props
}: PasswordFieldProps) {
	const [shown, setShown] = useState(false);
	return (
		<>
			<Label htmlFor={id}>{label}</Label>
			<div className="relative">
				<Input
					id={id}
					type={shown ? "text" : "password"}
					autoComplete={autoComplete}
					className={cn("pr-16", className)}
					{...props}
				/>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					aria-label={shown ? `Hide ${label}` : `Show ${label}`}
					aria-pressed={shown}
					onClick={() => setShown((s) => !s)}
					className="absolute top-1/2 right-1 min-h-11 min-w-11 -translate-y-1/2"
				>
					{shown ? "Hide" : "Show"}
				</Button>
			</div>
		</>
	);
}
