import { useState } from "react";
import { Button } from "@/components/ui/button";

const BIG = 256 * 1024;

type Props =
	| { text: string; contentType: string | null; filename?: string }
	| { value: unknown };

function parse(
	props: Props,
): { ok: true; value: unknown; size: number } | { ok: false; text: string } {
	if ("value" in props) return { ok: true, value: props.value, size: 0 };
	const isJson = /[/+]json\b/i.test(props.contentType ?? "");
	if (isJson) {
		try {
			return {
				ok: true,
				value: JSON.parse(props.text),
				size: props.text.length,
			};
		} catch {
			// Fall through to text: a body labelled JSON may still be broken.
		}
	}
	return { ok: false, text: props.text };
}

/**
 * Nested lists with disclosure buttons (each button carries aria-expanded),
 * rather than an ARIA tree that would need roving-focus keyboard handling.
 * Text nodes only: values are never interpreted as markup (spec §11). */
export function JsonViewer(props: Props) {
	const parsed = parse(props);
	if (!parsed.ok) {
		const name =
			"filename" in props && props.filename ? props.filename : "payload.txt";
		return (
			<div>
				<pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-3 font-mono text-xs">
					{parsed.text}
				</pre>
				<Button
					variant="outline"
					size="sm"
					className="mt-2"
					onClick={() => {
						const url = URL.createObjectURL(new Blob([parsed.text]));
						const a = document.createElement("a");
						a.href = url;
						a.download = name;
						a.click();
						URL.revokeObjectURL(url);
					}}
				>
					Download
				</Button>
			</div>
		);
	}
	const openDepth = parsed.size > BIG ? 1 : Number.POSITIVE_INFINITY;
	return (
		<ul
			aria-label="JSON"
			className="max-h-[480px] overflow-auto rounded bg-neutral-50 p-3 font-mono text-xs"
		>
			<Node name={null} value={parsed.value} depth={0} openDepth={openDepth} />
		</ul>
	);
}

function Node({
	name,
	value,
	depth,
	openDepth,
}: {
	name: string | null;
	value: unknown;
	depth: number;
	openDepth: number;
}) {
	const [open, setOpen] = useState(depth < openDepth);
	const label =
		name === null ? null : <span className="text-purple-700">{name}: </span>;
	if (value === null || typeof value !== "object") {
		return (
			<li className="pl-4">
				{label}
				<span
					className={
						typeof value === "string" ? "text-green-800" : "text-blue-800"
					}
				>
					{JSON.stringify(value)}
				</span>
			</li>
		);
	}
	const entries = Array.isArray(value)
		? value.map((v, i) => [String(i), v] as const)
		: Object.entries(value);
	const [l, r] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
	return (
		<li className="pl-4">
			<button
				type="button"
				aria-expanded={open}
				className="text-left hover:underline"
				onClick={() => setOpen(!open)}
			>
				{open ? "▾ " : "▸ "}
				{name ?? "root"} {l}
				{!open && `… ${entries.length} ${r}`}
			</button>
			{open && (
				<>
					<ul>
						{entries.map(([k, v]) => (
							<Node
								key={k}
								name={k}
								value={v}
								depth={depth + 1}
								openDepth={openDepth}
							/>
						))}
					</ul>
					<span className="pl-4">{r}</span>
				</>
			)}
		</li>
	);
}
