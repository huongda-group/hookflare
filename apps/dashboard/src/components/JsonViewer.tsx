import { useState } from "react";
import { Button } from "@/components/ui/button";

const BIG = 256 * 1024;

type Props =
	| {
			text: string;
			contentType: string | null;
			filename?: string;
			/** The original bytes for Download; defaults to the text as UTF-8. */
			download?: Blob;
	  }
	| { value: unknown };

type Parsed =
	| { ok: true; value: unknown; size: number; unsafe: boolean }
	| { ok: false };

// A JSON string literal or a bare integer token; strings are matched first so
// digits inside them are skipped. Fractions and exponents are not integers.
const TOKEN = /"(?:[^"\\]|\\.)*"|(?<![\w.+-])-?\d+(?![\w.])/g;

/** True when an integer literal outside strings exceeds MAX_SAFE_INTEGER. */
function hasUnsafeInteger(text: string): boolean {
	for (const [tok] of text.matchAll(TOKEN)) {
		if (tok.startsWith('"')) continue;
		const digits = tok.replace(/^-/, "");
		if (digits.length < 16) continue;
		if (BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)) return true;
	}
	return false;
}

function parse(props: Props): Parsed {
	if ("value" in props)
		return { ok: true, value: props.value, size: 0, unsafe: false };
	if (!/[/+]json\b/i.test(props.contentType ?? "")) return { ok: false };
	try {
		return {
			ok: true,
			value: JSON.parse(props.text),
			size: new TextEncoder().encode(props.text).length,
			unsafe: hasUnsafeInteger(props.text),
		};
	} catch {
		// Fall through to text: a body labelled JSON may still be broken.
		return { ok: false };
	}
}

export function downloadBlob(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}

/**
 * Nested lists with disclosure buttons (each button carries aria-expanded),
 * rather than an ARIA tree that would need roving-focus keyboard handling.
 * Text nodes only: values are never interpreted as markup (spec §11).
 * A text payload that parses as JSON also offers Raw, the exact original text,
 * since JSON.parse rounds integers beyond Number.MAX_SAFE_INTEGER. */
export function JsonViewer(props: Props) {
	const parsed = parse(props);
	const [raw, setRaw] = useState(false);
	if (!("text" in props)) {
		return parsed.ok ? <Tree value={parsed.value} size={0} /> : null;
	}
	const name = props.filename || "payload.txt";
	const view = (
		<pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-3 font-mono text-xs">
			{props.text}
		</pre>
	);
	return (
		<div>
			{parsed.ok && (
				<div className="mb-2 flex items-center gap-2">
					{(["Tree", "Raw"] as const).map((mode) => (
						<Button
							key={mode}
							variant={raw === (mode === "Raw") ? "secondary" : "ghost"}
							size="sm"
							aria-pressed={raw === (mode === "Raw")}
							onClick={() => setRaw(mode === "Raw")}
						>
							{mode}
						</Button>
					))}
					{parsed.unsafe && (
						<span className="text-amber-700 text-xs">
							Large numbers may be rounded in tree view — see Raw
						</span>
					)}
				</div>
			)}
			{parsed.ok && !raw ? (
				<Tree value={parsed.value} size={parsed.size} />
			) : (
				view
			)}
			<Button
				variant="outline"
				size="sm"
				className="mt-2"
				onClick={() =>
					downloadBlob(
						props.download ??
							new Blob([props.text], { type: props.contentType ?? "" }),
						name,
					)
				}
			>
				Download
			</Button>
		</div>
	);
}

function Tree({ value, size }: { value: unknown; size: number }) {
	const openDepth = size > BIG ? 1 : Number.POSITIVE_INFINITY;
	return (
		<ul
			aria-label="JSON"
			className="max-h-[480px] overflow-auto rounded bg-neutral-50 p-3 font-mono text-xs"
		>
			<Node name={null} value={value} depth={0} openDepth={openDepth} />
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
