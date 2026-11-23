import { useBlocker } from "@tanstack/react-router";
import {
	type JSX,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

export function DirtyFormGuard({
	dirty,
	children,
}: {
	dirty: boolean;
	children: (requestClose: (close: () => void) => void) => ReactNode;
}): JSX.Element {
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;

	const [pendingClose, setPendingClose] = useState<(() => void) | null>(null);

	const blocker = useBlocker({
		shouldBlockFn: () => dirtyRef.current,
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

	useEffect(() => {
		if (!pendingClose || dirty) return;
		setPendingClose(null);
		pendingClose();
	}, [pendingClose, dirty]);

	useEffect(() => {
		if (dirty || blocker.status !== "blocked") return;
		blocker.proceed();
	}, [dirty, blocker]);

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
					/* istanbul ignore else -- @preserve */
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
