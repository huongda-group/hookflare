export function createGate() {
	let release!: () => void;
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { release, wait: () => opened };
}
