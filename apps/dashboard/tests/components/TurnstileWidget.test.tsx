import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCRIPT_SRC =
	"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type RenderOptions = {
	sitekey: string;
	action: string;
	callback: (token: string) => void;
	"expired-callback": () => void;
	"error-callback": () => void;
};

/** A fresh module per test: the script promise is cached at module scope. */
async function loadWidget() {
	vi.resetModules();
	return (await import("@/components/TurnstileWidget")).TurnstileWidget;
}

const scripts = () =>
	[...document.head.querySelectorAll("script")].filter(
		(s) => s.src === SCRIPT_SRC,
	);

/** jsdom never fetches external scripts, so the test settles the tag itself. */
const settle = async (script: HTMLScriptElement, type: "load" | "error") => {
	script.dispatchEvent(new Event(type));
	// Let the load promise's handlers run.
	await Promise.resolve();
	await Promise.resolve();
};

beforeEach(() => {
	window.turnstile = undefined;
});
afterEach(() => {
	for (const s of scripts()) s.remove();
	window.turnstile = undefined;
});

describe("TurnstileWidget script loading", () => {
	it("injects the script once and blocks with an error when it fails, retrying on the next mount", async () => {
		const TurnstileWidget = await loadWidget();
		const onToken = vi.fn();
		const first = render(
			<TurnstileWidget
				siteKey="0xKEY"
				action="login"
				onToken={onToken}
				resetKey={0}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Loading security check…",
		);
		expect(scripts()).toHaveLength(1);
		expect(scripts()[0].async).toBe(true);
		expect(scripts()[0].defer).toBe(true);

		await settle(scripts()[0], "error");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/security check failed to load/i,
		);
		expect(onToken).toHaveBeenLastCalledWith(null);

		first.unmount();
		scripts()[0].remove();
		render(
			<TurnstileWidget
				siteKey="0xKEY"
				action="login"
				onToken={onToken}
				resetKey={0}
			/>,
		);
		// The failed load is forgotten, so a new mount tries again.
		expect(scripts()).toHaveLength(1);
	});

	it("ignores a script failure that lands after unmount", async () => {
		const TurnstileWidget = await loadWidget();
		const onToken = vi.fn();
		const view = render(
			<TurnstileWidget
				siteKey="0xKEY"
				action="setup"
				onToken={onToken}
				resetKey={0}
			/>,
		);
		view.unmount();
		await settle(scripts()[0], "error");
		expect(onToken).not.toHaveBeenCalled();
	});

	it("renders the widget once the script loads and forwards its tokens", async () => {
		const TurnstileWidget = await loadWidget();
		const onToken = vi.fn();
		let options!: RenderOptions;
		const renderWidget = vi.fn((_el: HTMLElement, o: RenderOptions) => {
			options = o;
			return "wid_1";
		});
		const reset = vi.fn();
		const props = { siteKey: "0xKEY", action: "login" as const, onToken };
		const view = render(<TurnstileWidget {...props} resetKey={0} />);

		// A reset before the widget exists only drops any token.
		view.rerender(<TurnstileWidget {...props} resetKey={1} />);
		expect(onToken).toHaveBeenLastCalledWith(null);
		expect(reset).not.toHaveBeenCalled();

		window.turnstile = { render: renderWidget, reset };
		await settle(scripts()[0], "load");
		await vi.waitFor(() => expect(renderWidget).toHaveBeenCalledTimes(1));
		expect(options).toMatchObject({ sitekey: "0xKEY", action: "login" });
		await vi.waitFor(() =>
			expect(screen.queryByRole("status")).not.toBeInTheDocument(),
		);

		options.callback("tok_1");
		expect(onToken).toHaveBeenLastCalledWith("tok_1");
		options["expired-callback"]();
		expect(onToken).toHaveBeenLastCalledWith(null);

		view.unmount();
		// A late widget error after unmount still drops the token, without state updates.
		onToken.mockClear();
		options["error-callback"]();
		expect(onToken).toHaveBeenCalledWith(null);
	});

	it("waits without rendering when the script loaded but exposed no API", async () => {
		const TurnstileWidget = await loadWidget();
		const view = render(
			<TurnstileWidget
				siteKey="0xKEY"
				action="login"
				onToken={() => {}}
				resetKey={0}
			/>,
		);
		await settle(scripts()[0], "load");
		expect(screen.getByRole("status")).toHaveTextContent(
			"Loading security check…",
		);
		view.unmount();
	});

	it("does not render a widget for a mount that ended before the script loaded", async () => {
		const TurnstileWidget = await loadWidget();
		const renderWidget = vi.fn(() => "wid_1");
		const view = render(
			<TurnstileWidget
				siteKey="0xKEY"
				action="login"
				onToken={() => {}}
				resetKey={0}
			/>,
		);
		view.unmount();
		window.turnstile = { render: renderWidget, reset: vi.fn() };
		await settle(scripts()[0], "load");
		expect(renderWidget).not.toHaveBeenCalled();
	});
});
