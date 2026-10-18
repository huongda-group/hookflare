import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { TimeText } from "@/components/TimeText";
import { formatAbsolute } from "@/lib/time";

/** One labelled value in a detail page's definition list. */
export function Field({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="space-y-0.5">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="text-sm">{children}</dd>
		</div>
	);
}

export function FieldList({ children }: { children: ReactNode }) {
	return (
		<dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{children}
		</dl>
	);
}

export function Section({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="space-y-3">
			<h2 className="text-sm font-semibold">{title}</h2>
			{children}
		</section>
	);
}

/** Current fingerprint, plus the grace window while a rotated-out secret is still accepted. */
export function SecretFingerprints({
	fingerprint,
	previous,
	previousExpiresAt,
}: {
	fingerprint: string | null;
	previous: string | null;
	previousExpiresAt: number | null;
}) {
	return (
		<FieldList>
			<Field label="Secret fingerprint">
				{fingerprint ? (
					<span className="font-mono text-xs">{fingerprint}</span>
				) : (
					<span className="text-muted-foreground">No secret</span>
				)}
			</Field>
			{previous && (
				<Field label="Previous secret fingerprint">
					<span className="font-mono text-xs">{previous}</span>
					{previousExpiresAt !== null && (
						<p className="mt-1 text-xs text-warning">
							Previous secret valid until {formatAbsolute(previousExpiresAt)} (
							<TimeText ms={previousExpiresAt} />)
						</p>
					)}
				</Field>
			)}
		</FieldList>
	);
}

export function BackToEndpoints({
	tab,
	projectId,
}: {
	tab: "sources" | "destinations";
	projectId?: string;
}) {
	return (
		<Link
			to="/endpoints"
			search={{ tab, project_id: projectId }}
			className="text-sm text-muted-foreground underline"
		>
			← Endpoints
		</Link>
	);
}
