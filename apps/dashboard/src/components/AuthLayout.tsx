import type { JSX, ReactNode } from "react";

/**
 * The shared light two-column frame for Setup and Login (spec §8.1–8.2,
 * direction B everywhere, no dark panel).
 *
 * Desktop: an understated Hookflare explanation on the left, the focused
 * 360–400px form on the right. Mobile: one column with the brand, a short
 * intro, then the form — no oversized top margins pushing the submit off
 * screen.
 */
export function AuthLayout({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}): JSX.Element {
	return (
		<main className="mx-auto w-full max-w-4xl px-4 py-10 md:py-16">
			<div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(360px,400px)] md:items-start">
				<div>
					<p className="text-lg font-semibold text-foreground">Hookflare</p>
					<p className="mt-2 text-sm text-muted-foreground md:hidden">
						Webhook delivery with a searchable record of every event.
					</p>
					<div className="mt-6 hidden max-w-md space-y-4 md:block">
						<p className="text-sm leading-relaxed text-muted-foreground">
							Hookflare receives your webhooks, delivers them to your
							backends, and keeps a searchable record of every event,
							delivery, and attempt.
						</p>
						<p className="text-sm leading-relaxed text-muted-foreground">
							Sign in to inspect deliveries, recover from failures, and
							configure ingress and delivery — all from one operations
							view.
						</p>
					</div>
				</div>
				<div className="w-full max-w-[400px]">
					<h1 className="text-[26px] leading-snug font-semibold text-foreground">
						{title}
					</h1>
					<p className="mt-1 text-sm text-muted-foreground">{description}</p>
					<div className="mt-6">{children}</div>
				</div>
			</div>
		</main>
	);
}

/**
 * WCAG 2.2 intent (spec §11): the first invalid field receives focus after a
 * failed submit. Pages pass their ordered field-name → element-id map and a
 * predicate over the submit-time error object.
 */
export function focusFirstInvalidField(
	ids: Record<string, string>,
	hasError: (name: string) => boolean,
): void {
	const name = Object.keys(ids).find((key) => hasError(key));
	if (name) document.getElementById(ids[name])?.focus();
}
