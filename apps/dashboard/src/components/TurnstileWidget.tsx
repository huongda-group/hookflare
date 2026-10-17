import { useEffect, useRef } from "react";

const SCRIPT_SRC =
	"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileRenderOptions = {
	sitekey: string;
	action: string;
	callback: (token: string) => void;
	"expired-callback": () => void;
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
 * The explicit-render Turnstile widget (spec §6.5.1). Tokens are single-use,
 * so the page bumps `resetKey` after every failed submit and the yielded token
 * is dropped. With `siteKey === null` Turnstile is off and only a notice shows.
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
	// The callback is read through a ref so a re-render never re-renders the widget.
	const onTokenRef = useRef(onToken);
	useEffect(() => {
		onTokenRef.current = onToken;
	}, [onToken]);

	useEffect(() => {
		if (siteKey === null) return;
		let cancelled = false;
		void loadTurnstile()
			.then(() => {
				if (cancelled || !container.current || !window.turnstile) return;
				widgetId.current = window.turnstile.render(container.current, {
					sitekey: siteKey,
					action,
					callback: (token) => onTokenRef.current(token),
					"expired-callback": () => onTokenRef.current(null),
				});
			})
			.catch(() => onTokenRef.current(null));
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
		return <p className="text-neutral-500">Turnstile is off</p>;
	return <div ref={container} />;
}
