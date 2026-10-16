export function NoAccess({ email }: { email?: string }) {
	return (
		<main className="mx-auto mt-24 max-w-md text-center">
			<h1 className="text-2xl font-semibold">No access</h1>
			<p className="mt-3 text-neutral-600">
				{email ?? "Your account"} is signed in through Access but is not a
				Hookflare user. Ask an admin to add it under Settings › Users.
			</p>
		</main>
	);
}
