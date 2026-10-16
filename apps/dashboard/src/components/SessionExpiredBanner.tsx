import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { isSessionExpired, subscribeSessionExpired } from "@/lib/api";

/** Blocking but not destructive: the page under it keeps its form state (spec §13). */
export function SessionExpiredBanner() {
	const expired = useSyncExternalStore(
		subscribeSessionExpired,
		isSessionExpired,
	);
	if (!expired) return null;
	return (
		<div
			role="alert"
			className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-4 bg-amber-100 p-3 text-amber-900 shadow"
		>
			<span>
				Session expired or network unavailable — reload to sign in again. Copy
				any unsaved input first.
			</span>
			<Button size="sm" onClick={() => window.location.reload()}>
				Reload
			</Button>
		</div>
	);
}
