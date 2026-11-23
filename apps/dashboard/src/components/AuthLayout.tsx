import { ArrowRight, ListChecks, Radio, Send, ShieldCheck } from "lucide-react";
import type { JSX, ReactNode } from "react";

const deliverySteps = [
	{ label: "Event", detail: "received", Icon: Radio },
	{ label: "Delivery", detail: "tracked", Icon: Send },
	{ label: "Attempt", detail: "recorded", Icon: ListChecks },
] as const;

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
					<img
						src="/favicon.svg"
						alt=""
						className="size-9 shrink-0 object-contain"
					/>
					<span className="text-xl font-semibold tracking-[-0.03em]">
						hookflare
					</span>
				</header>
				<div className="grid flex-1 content-start gap-10 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(420px,480px)] lg:content-center lg:items-center lg:gap-20 lg:py-12">
					<section
						className="hidden min-w-0 lg:block"
						aria-label="About Hookflare"
					>
						<p className="mb-4 inline-flex items-center gap-2 text-xs font-semibold tracking-[0.12em] text-info uppercase">
							<Radio className="size-4" aria-hidden="true" /> Webhook operations
						</p>
						<h2 className="max-w-[21ch] text-[clamp(2rem,3.4vw,3.25rem)] leading-[1.1] font-semibold tracking-[-0.04em] text-balance">
							Trace every webhook delivery.
						</h2>
						<p className="mt-4 max-w-[43ch] text-base leading-7 text-muted-foreground">
							Receive webhooks, route them to your backends, and inspect every
							delivery attempt.
						</p>
						<div className="mt-8 max-w-[30rem] rounded-lg border border-border bg-surface">
							<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3 xl:px-5">
								<h3 id="auth-delivery-path" className="text-sm font-semibold">
									Delivery path
								</h3>
								<span className="text-xs text-muted-foreground">
									From receipt to attempt
								</span>
							</div>
							<ol
								aria-labelledby="auth-delivery-path"
								className="grid grid-cols-3 gap-x-(--step-gap) px-4 py-4 text-center [--step-gap:3.5rem] xl:px-5"
							>
								{deliverySteps.map(({ label, detail, Icon }, index) => (
									<li key={label} className="min-w-0">
										<div
											aria-hidden="true"
											className="relative flex justify-center"
										>
											<span className="grid size-9 shrink-0 place-items-center rounded-md bg-info-surface text-info">
												<Icon className="size-4" />
											</span>
											{index < deliverySteps.length - 1 && (
												<span className="absolute top-1/2 right-[calc(-50%-var(--step-gap)+1.5rem)] left-[calc(50%+1.5rem)] flex -translate-y-1/2 items-center text-muted-foreground">
													<span className="h-px flex-1 bg-border" />
													<ArrowRight className="size-3 shrink-0" />
												</span>
											)}
										</div>
										<p className="mt-2 text-sm font-semibold">
											{label}{" "}
											<span className="block text-xs leading-5 font-normal text-muted-foreground">
												{detail}
											</span>
										</p>
									</li>
								))}
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
