import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { resetSessionExpired } from "@/lib/api";
import { server } from "./server";

// findBy*/waitFor default to 1 s, which a loaded runner (all workspaces at once) can miss.
configure({ asyncUtilTimeout: 5_000 });

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
	cleanup();
	server.resetHandlers();
	resetSessionExpired();
});
afterAll(() => server.close());

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver ??=
	ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

// jsdom lacks matchMedia; sonner/next-themes call it on mount.
window.matchMedia ??= () =>
	({
		matches: false,
		media: "",
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	}) as unknown as MediaQueryList;
