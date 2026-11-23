/**
 * A latch for msw handlers: `await gate.wait()` holds a response until the
 * test calls `gate.release()`, so a test can act while a request is in flight
 * without sleeping.
 */
export function createGate() {
	let release!: () => void;
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { release, wait: () => opened };
}
