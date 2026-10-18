import { useBlocker } from "@tanstack/react-router";
import { type JSX, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/**
 * Warns before discarding dirty configuration (spec §7).
 *
 * - Same-app navigation is blocked while `dirty` (TanStack Router blocker).
 * - A form cancel/close request goes through `requestClose`, so callers keep
 *   their existing close callback and only the guard decides to prompt.
 * - A native `beforeunload` listener is attached only while dirty and removed
 *   on cleanup, so a clean form never blocks a reload.
 * - A successful save clears `dirty` before closing: the deferred request is
 *   flushed without a prompt.
 */
export function DirtyFormGuard({
	dirty,
	children,
}: {
	dirty: boolean;
	children: (requestClose: (close: () => void) => void) => ReactNode;
}): JSX.Element {
	// Read the latest value at call time; a save that clears `dirty` and then
	// closes in the same handler must not prompt.
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;

	const [pendingClose, setPendingClose] = useState<(() => void) | null>(null);

	const blocker = useBlocker({
		shouldBlockFn: () => dirtyRef.current,
		// The unload guard below is attached only while dirty.
		enableBeforeUnload: false,
		withResolver: true,
	});

	useEffect(() => {
		if (!dirty) return;
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [dirty]);

	// `dirty` flipped back to false while a close was pending: the save
	// succeeded, so let the close through without a prompt.
	useEffect(() => {
		if (!pendingClose || dirty) return;
		setPendingClose(null);
		pendingClose();
	}, [pendingClose, dirty]);

	const requestClose = useCallback((close: () => void) => {
		if (!dirtyRef.current) {
			close();
			return;
		}
		setPendingClose(() => close);
	}, []);

	const blocked = blocker.status === "blocked";

	function keepEditing() {
		setPendingClose(null);
		if (blocker.status === "blocked") blocker.reset();
	}

	function discard() {
		const close = pendingClose;
		setPendingClose(null);
		if (blocker.status === "blocked") blocker.proceed();
		close?.();
	}

	return (
		<>
			{children(requestClose)}
			<Dialog
				open={dirty && (blocked || pendingClose !== null)}
				onOpenChange={(open) => {
					if (!open) keepEditing();
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Discard unsaved changes?</DialogTitle>
						<DialogDescription>
							This form has unsaved changes. Leaving now discards them.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={keepEditing}>
							Keep editing
						</Button>
						<Button variant="destructive" onClick={discard}>
							Discard changes
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
