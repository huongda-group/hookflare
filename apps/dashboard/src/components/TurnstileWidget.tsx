import { useEffect, useRef, useState } from "react";

const SCRIPT_SRC =
	"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileRenderOptions = {
	sitekey: string;
	action: string;
	callback: (token: string) => void;
	"expired-callback": () => void;
	"error-callback": () => void;
};

type TurnstileApi = {
	render: (element: HTMLElement, options: TurnstileRenderOptions) => string;
	reset: (widgetId?: string) => void;
};

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let scriptPromise: Promise<void> | null = null;

/** Loads `api.js` exactly once per page, whoever renders first (spec §6.5.1). */
function loadTurnstile(): Promise<void> {
	if (window.turnstile) return Promise.resolve();
	scriptPromise ??= new Promise<void>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = SCRIPT_SRC;
		script.async = true;
		script.defer = true;
		script.onload = () => resolve();
		script.onerror = () => {
			scriptPromise = null;
			reject(new Error("Turnstile failed to load"));
		};
		document.head.append(script);
	});
	return scriptPromise;
}

/**
 * The explicit-render Turnstile widget (spec §6.5.1, §8.1–8.2). States are
 * explicit: loading while the script renders, off (a neutral notice naming
 * what still protects the form), and error/expiry (a blocking server error
 * is surfaced, never a UI bypass). Tokens are single-use, so the page bumps
 * `resetKey` after every failed submit and the yielded token is dropped.
 */
export function TurnstileWidget({
	siteKey,
	action,
	onToken,
	resetKey,
}: {
	siteKey: string | null;
	action: "login" | "setup";
	onToken: (token: string | null) => void;
	resetKey: number;
}) {
	const container = useRef<HTMLDivElement>(null);
	const widgetId = useRef<string | null>(null);
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
	// The callback is read through a ref so a re-render never re-renders the widget.
	const onTokenRef = useRef(onToken);
	useEffect(() => {
		onTokenRef.current = onToken;
	}, [onToken]);

	useEffect(() => {
		if (siteKey === null) return;
		setStatus("loading");
		let cancelled = false;
		void loadTurnstile()
			.then(() => {
				if (cancelled || !container.current || !window.turnstile) return;
				widgetId.current = window.turnstile.render(container.current, {
					sitekey: siteKey,
					action,
					callback: (token) => onTokenRef.current(token),
					"expired-callback": () => onTokenRef.current(null),
					"error-callback": () => {
						if (!cancelled) setStatus("error");
						onTokenRef.current(null);
					},
				});
				if (!cancelled) setStatus("ready");
			})
			.catch(() => {
				if (cancelled) return;
				setStatus("error");
				onTokenRef.current(null);
			});
		return () => {
			cancelled = true;
		};
	}, [siteKey, action]);

	useEffect(() => {
		if (siteKey === null || resetKey === 0) return;
		if (widgetId.current) window.turnstile?.reset(widgetId.current);
		onTokenRef.current(null);
	}, [resetKey, siteKey]);

	if (siteKey === null)
		return (
			<p className="text-sm text-muted-foreground">
				{action === "setup"
					? "Bot protection is off. The setup token is still required."
					: "Bot protection is off."}
			</p>
		);
	if (status === "error")
		return (
			<p role="alert" className="text-sm text-failure">
				The security check failed to load. Reload the page and try again —
				sign-in stays blocked until it succeeds.
			</p>
		);
	return (
		<div>
			<div ref={container} />
			{status === "loading" ? (
				<p role="status" className="text-sm text-muted-foreground">
					Loading security check…
				</p>
			) : null}
		</div>
	);
}
