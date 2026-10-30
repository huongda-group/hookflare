import {
	ArrowDownRight,
	ArrowRight,
	ListChecks,
	Radio,
	Send,
	ShieldCheck,
} from "lucide-react";
import type { JSX, ReactNode } from "react";

/**
 * Shared first-run and sign-in frame. The illustration describes the actual
 * event → delivery → attempt relationship, without invented activity data.
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
		<main className="min-h-screen bg-canvas text-foreground">
			<div className="mx-auto flex min-h-screen w-full max-w-[1280px] flex-col px-5 py-6 sm:px-8 lg:px-12 lg:py-9">
				<header className="flex items-center gap-3">
					<span className="flex size-9 items-center justify-center rounded-lg bg-brand text-white shadow-[0_3px_10px_#253b6926]">
						<ArrowDownRight className="size-5" aria-hidden="true" />
					</span>
					<span className="text-xl font-semibold tracking-[-0.03em]">
						hookflare
					</span>
				</header>
				<div className="grid flex-1 content-start gap-10 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(420px,480px)] lg:content-center lg:items-center lg:gap-20 lg:py-12">
					<section
						className="hidden min-w-0 lg:block"
						aria-label="About Hookflare"
					>
						<p className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-action">
							<Radio className="size-4" aria-hidden="true" /> Webhook operations
						</p>
						<h2 className="max-w-[16ch] text-[clamp(2.5rem,4vw,3.75rem)] leading-[1.09] font-semibold tracking-[-0.035em]">
							Every delivery has a story.
						</h2>
						<p className="mt-6 max-w-[45ch] text-base leading-7 text-muted-foreground">
							Receive webhooks, deliver to your backends, and trace every
							attempt from one clear operations view.
						</p>
						<div className="mt-12 w-full overflow-hidden rounded-xl border border-border bg-white shadow-[0_12px_32px_#2027330a]">
							<div className="flex items-baseline justify-between gap-3 border-b border-border px-6 py-4">
								<span className="text-sm font-semibold text-foreground">
									Delivery path
								</span>
								<span className="text-xs text-muted-foreground">
									A record of every step
								</span>
							</div>
							<ol
								aria-label="Delivery path"
								className="grid grid-cols-3 px-5 py-7"
							>
								<li className="relative flex min-w-0 flex-col items-center text-center">
									<span
										aria-hidden="true"
										className="absolute top-[22px] left-[calc(50%+28px)] w-[calc(100%-56px)] border-t border-border"
									/>
									<ArrowRight
										aria-hidden="true"
										className="absolute top-[15px] right-[-8px] size-4 bg-white text-muted-foreground"
									/>
									<span className="relative flex size-11 items-center justify-center rounded-xl bg-info-surface text-info">
										<Radio className="size-5" aria-hidden="true" />
									</span>
									<span className="mt-3 text-sm font-semibold">Event</span>
									<span className="mt-1 text-xs text-muted-foreground">
										Received
									</span>
								</li>
								<li className="relative flex min-w-0 flex-col items-center text-center">
									<span
										aria-hidden="true"
										className="absolute top-[22px] left-[calc(50%+28px)] w-[calc(100%-56px)] border-t border-border"
									/>
									<ArrowRight
										aria-hidden="true"
										className="absolute top-[15px] right-[-8px] size-4 bg-white text-muted-foreground"
									/>
									<span className="relative flex size-11 items-center justify-center rounded-xl bg-info-surface text-info">
										<Send className="size-5" aria-hidden="true" />
									</span>
									<span className="mt-3 text-sm font-semibold">Delivery</span>
									<span className="mt-1 text-xs text-muted-foreground">
										Tracked
									</span>
								</li>
								<li className="flex min-w-0 flex-col items-center text-center">
									<span className="flex size-11 items-center justify-center rounded-xl bg-info-surface text-info">
										<ListChecks className="size-5" aria-hidden="true" />
									</span>
									<span className="mt-3 text-sm font-semibold">Attempt</span>
									<span className="mt-1 text-xs text-muted-foreground">
										Recorded
									</span>
								</li>
							</ol>
						</div>
					</section>
					<section
						aria-labelledby="auth-title"
						className="w-full min-w-0 rounded-xl border border-border bg-white p-5 shadow-[0_16px_48px_#2027330b] sm:p-8 lg:p-10"
					>
						<div className="mb-7 flex size-11 items-center justify-center rounded-lg bg-info-surface text-info">
							<ShieldCheck className="size-5" aria-hidden="true" />
						</div>
						<h1
							id="auth-title"
							className="text-[26px] leading-tight font-semibold tracking-[-0.025em] text-foreground sm:text-[28px]"
						>
							{title}
						</h1>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">
							{description}
						</p>
						<div className="mt-7">{children}</div>
					</section>
				</div>
				<footer className="text-xs text-muted-foreground">
					Hookflare · Self-hosted webhook operations
				</footer>
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
