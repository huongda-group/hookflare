import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import type { ComponentProps, ReactElement } from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/router";
import { destination, project, source } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { apiUrl, server } from "@/test/server";
import { DestinationSelect } from "./DestinationSelect";
import { ResourceLabel } from "./ResourceLabel";
import { ResourcePicker } from "./ResourcePicker";

/** Cursor pages of 50 rows keyed by their offset, recording each request. */
function paged(path: string, rows: unknown[]) {
	const calls: URLSearchParams[] = [];
	server.use(
		http.get(apiUrl(path), ({ request }) => {
			const params = new URL(request.url).searchParams;
			calls.push(params);
			const start = params.get("cursor") ? Number(params.get("cursor")) : 0;
			const data = rows.slice(start, start + 50);
			const next = start + 50 < rows.length ? String(start + 50) : null;
			return HttpResponse.json({ data, next_cursor: next });
		}),
	);
	return calls;
}

/** 201 uniquely identified but identically named sources, as the plan describes. */
const storeEvents = (n: number) =>
	Array.from({ length: n }, (_, i) =>
		source({ id: `src_${i + 1}`, name: "Store events", project_id: "prj_1" }),
	);

function renderWith(ui: ReactElement, client = createQueryClient()) {
	const user = userEvent.setup();
	return {
		client,
		user,
		...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
	};
}

function Picker(props: ComponentProps<typeof ResourcePicker>) {
	return <ResourcePicker {...props} />;
}

describe("ResourcePicker", () => {
	it("loads five pages of 201 options and selects the last one after Load more", async () => {
		const calls = paged("/sources", storeEvents(201));
		const onChange = vi.fn();
		const { user } = renderWith(
			<Picker kind="source" label="Source" onChange={onChange} />,
		);

		await user.click(screen.getByRole("combobox", { name: "Source" }));
		expect(
			await screen.findByRole("option", { name: /src_1\b/ }),
		).toBeInTheDocument();
		// Only the first page is requested up front.
		expect(calls).toHaveLength(1);

		for (const last of [51, 101, 151, 201]) {
			await user.click(screen.getByRole("button", { name: "Load more" }));
			expect(
				await screen.findByRole("option", {
					name: new RegExp(`src_${last}\\b`),
				}),
			).toBeInTheDocument();
		}

		expect(screen.getAllByRole("option")).toHaveLength(201);
		expect(calls).toHaveLength(5);
		for (const call of calls) expect(call.get("limit")).toBe("50");
		expect(
			screen.queryByRole("button", { name: "Load more" }),
		).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("option", { name: /Store events.*src_201/ }),
		);
		expect(onChange).toHaveBeenLastCalledWith("src_201");
	});

	it("disambiguates duplicate names with the short ID and project, and keeps unique names plain", async () => {
		server.use(
			http.get(apiUrl("/sources"), () =>
				HttpResponse.json({
					data: [
						source({
							id: "src_dup1",
							name: "Store events",
							project_id: "prj_a",
						}),
						source({
							id: "src_dup2",
							name: "Store events",
							project_id: "prj_b",
						}),
						source({ id: "src_uniq", name: "Stripe", project_id: "prj_a" }),
					],
					next_cursor: null,
				}),
			),
		);
		const { user } = renderWith(
			<Picker kind="source" label="Source" onChange={() => {}} />,
		);
		await user.click(screen.getByRole("combobox", { name: "Source" }));

		expect(
			await screen.findByRole("option", {
				name: /Store events.*src_dup1.*prj_a/,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: /Store events.*src_dup2.*prj_b/ }),
		).toBeInTheDocument();
		// A unique name stays exactly the name, so existing exact-name lookups
		// keep working.
		expect(screen.getByRole("option", { name: "Stripe" })).toBeInTheDocument();
	});

	it("labels the local search 'Search loaded options' and never requests the backend per keystroke", async () => {
		const calls = paged("/sources", storeEvents(100));
		const { user } = renderWith(
			<Picker kind="source" label="Source" onChange={() => {}} />,
		);
		await user.click(screen.getByRole("combobox", { name: "Source" }));
		await screen.findByRole("option", { name: /src_1\b/ });

		expect(screen.getByText("Search loaded options")).toBeInTheDocument();
		await user.type(screen.getByLabelText("Search loaded options"), "77");

		expect(
			screen.queryByRole("option", { name: /src_77\b/ }),
		).not.toBeInTheDocument();
		expect(screen.getByText(/no loaded options match/i)).toBeInTheDocument();
		expect(calls).toHaveLength(1);

		await user.click(screen.getByRole("button", { name: "Load more" }));
		expect(
			await screen.findByRole("option", { name: /src_77\b/ }),
		).toBeInTheDocument();
		expect(calls).toHaveLength(2);
	});

	it("keeps an unresolved deep-link selection while its name loads", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		server.use(
			http.get(apiUrl("/destinations"), async () => {
				await gate;
				return HttpResponse.json({
					data: [destination({ id: "dst_1", name: "Billing API" })],
					next_cursor: null,
				});
			}),
		);
		const { user } = renderWith(
			<Picker
				kind="destination"
				label="Destination"
				value="dst_999"
				onChange={() => {}}
			/>,
		);
		const trigger = screen.getByRole("combobox", { name: "Destination" });
		expect(trigger).toHaveTextContent("dst_999");

		await waitFor(() => expect(release).toBeDefined());
		release?.();
		await user.click(trigger);
		expect(
			await screen.findByRole("option", { name: "Billing API" }),
		).toBeInTheDocument();
		// The unloaded deep-link ID is still usable and still shown.
		expect(trigger).toHaveTextContent("dst_999");
	});

	it("replaces the raw ID with the loaded name once the option arrives", async () => {
		server.use(
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({
					data: [destination({ id: "dst_1", name: "Billing API" })],
					next_cursor: null,
				}),
			),
		);
		renderWith(
			<Picker
				kind="destination"
				label="Destination"
				value="dst_1"
				onChange={() => {}}
			/>,
		);
		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "Destination" }),
			).toHaveTextContent("Billing API"),
		);
	});

	it("submits an exact ID that is not in the loaded options", async () => {
		const detail = vi.fn();
		server.use(
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({
					data: [destination({ id: "dst_1", name: "Billing API" })],
					next_cursor: null,
				}),
			),
			http.get(apiUrl("/destinations/:id"), () => {
				detail();
				return HttpResponse.json(destination());
			}),
		);
		const onChange = vi.fn();
		const { user } = renderWith(
			<Picker kind="destination" label="Destination" onChange={onChange} />,
		);

		await user.click(screen.getByRole("combobox", { name: "Destination" }));
		await screen.findByRole("option", { name: "Billing API" });
		await user.type(screen.getByLabelText("Exact destination ID"), "dst_999");
		await user.click(screen.getByRole("button", { name: "Use ID" }));
		expect(onChange).toHaveBeenLastCalledWith("dst_999");

		await user.click(screen.getByRole("combobox", { name: "Destination" }));
		await user.type(
			screen.getByLabelText("Exact destination ID"),
			"dst_888{Enter}",
		);
		expect(onChange).toHaveBeenLastCalledWith("dst_888");

		// The backend stays authoritative: typing an ID does not fetch it.
		expect(detail).not.toHaveBeenCalled();
	});

	it("does not show stale options after the project changes", async () => {
		const calls: URLSearchParams[] = [];
		server.use(
			http.get(apiUrl("/destinations"), ({ request }) => {
				const params = new URL(request.url).searchParams;
				calls.push(params);
				const second = params.get("project_id") === "prj_2";
				return HttpResponse.json({
					data: [
						destination({
							id: second ? "dst_2" : "dst_1",
							name: second ? "Beta" : "Alpha",
							project_id: params.get("project_id") ?? "prj_1",
						}),
					],
					next_cursor: null,
				});
			}),
		);
		const onChange = vi.fn();
		function Harness() {
			const [projectId, setProjectId] = useState("prj_1");
			return (
				<>
					<button type="button" onClick={() => setProjectId("prj_2")}>
						Switch project
					</button>
					<Picker
						kind="destination"
						projectId={projectId}
						label="Destination"
						value="dst_1"
						onChange={onChange}
					/>
				</>
			);
		}
		const { user } = renderWith(<Harness />);

		await user.click(screen.getByRole("combobox", { name: "Destination" }));
		expect(
			await screen.findByRole("option", { name: "Alpha" }),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Switch project" }));
		await waitFor(() =>
			expect(
				screen.queryByRole("option", { name: "Alpha" }),
			).not.toBeInTheDocument(),
		);

		await user.click(screen.getByRole("combobox", { name: "Destination" }));
		expect(
			await screen.findByRole("option", { name: "Beta" }),
		).toBeInTheDocument();
		expect(calls.at(-1)?.get("project_id")).toBe("prj_2");
		// The page owns clearing invalid selections; the picker must not.
		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps the selected ID and offers Retry when the option page fails", async () => {
		let failing = true;
		server.use(
			http.get(apiUrl("/destinations"), () =>
				failing
					? HttpResponse.json({ error: "internal" }, { status: 500 })
					: HttpResponse.json({
							data: [destination({ id: "dst_1", name: "Billing API" })],
							next_cursor: null,
						}),
			),
		);
		const onChange = vi.fn();
		const { user } = renderWith(
			<Picker
				kind="destination"
				label="Destination"
				value="dst_999"
				onChange={onChange}
			/>,
		);
		const trigger = screen.getByRole("combobox", { name: "Destination" });
		expect(trigger).toHaveTextContent("dst_999");

		await user.click(trigger);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/could not load options/i);

		failing = false;
		await user.click(screen.getByRole("button", { name: "Retry" }));

		expect(
			await screen.findByRole("option", { name: "Billing API" }),
		).toBeInTheDocument();
		expect(trigger).toHaveTextContent("dst_999");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps loaded options and retries only the failed next page", async () => {
		let failingNext = false;
		server.use(
			http.get(apiUrl("/sources"), ({ request }) => {
				const cursor = new URL(request.url).searchParams.get("cursor");
				if (!cursor)
					return HttpResponse.json({
						data: [source({ id: "src_1", name: "Stripe" })],
						next_cursor: "1",
					});
				if (failingNext)
					return HttpResponse.json({ error: "internal" }, { status: 500 });
				return HttpResponse.json({
					data: [source({ id: "src_2", name: "Ledger" })],
					next_cursor: null,
				});
			}),
		);
		const { user } = renderWith(
			<Picker kind="source" label="Source" onChange={() => {}} />,
		);
		await user.click(screen.getByRole("combobox", { name: "Source" }));
		await screen.findByRole("option", { name: "Stripe" });

		failingNext = true;
		await user.click(screen.getByRole("button", { name: "Load more" }));

		expect(await screen.findByRole("status")).toHaveTextContent(
			/could not load more/i,
		);
		expect(screen.getByRole("option", { name: "Stripe" })).toBeInTheDocument();

		failingNext = false;
		await user.click(
			screen.getByRole("button", { name: "Retry loading more" }),
		);
		expect(
			await screen.findByRole("option", { name: "Ledger" }),
		).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Stripe" })).toBeInTheDocument();
	});

	it("offers All as the first option when allowAll is set", async () => {
		server.use(
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({
					data: [destination({ id: "dst_1", name: "Billing API" })],
					next_cursor: null,
				}),
			),
		);
		const onChange = vi.fn();
		const { user } = renderWith(
			<DestinationSelect value="dst_1" onChange={onChange} />,
		);
		const trigger = screen.getByRole("combobox", { name: "Destination" });
		await waitFor(() => expect(trigger).toHaveTextContent("Billing API"));

		await user.click(trigger);
		expect(
			await screen.findByRole("option", { name: "All destinations" }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("option", { name: "All destinations" }));
		expect(onChange).toHaveBeenLastCalledWith(undefined);
	});
});

describe("ResourceLabel", () => {
	it("reads shared cached pages without any request, falling back to the ID", async () => {
		const calls = paged("/sources", storeEvents(10));
		renderWith(
			<>
				<Picker
					kind="source"
					projectId="prj_1"
					label="Source"
					onChange={() => {}}
				/>
				<ResourceLabel kind="source" id="src_3" projectId="prj_1" />
			</>,
		);

		await waitFor(() =>
			expect(screen.getByText("Store events")).toBeInTheDocument(),
		);
		expect(calls).toHaveLength(1);

		// A label with no cached page still renders the raw ID and issues no fetch.
		const isolated = paged("/destinations", [destination()]);
		renderWith(<ResourceLabel kind="destination" id="dst_999" />);
		expect(screen.getByText("dst_999")).toBeInTheDocument();
		await Promise.resolve();
		expect(isolated).toHaveLength(0);
	});

	it("issues no per-row detail requests and reuses the cache across a remount", async () => {
		const detail = vi.fn();
		const list = paged("/sources", storeEvents(50));
		server.use(
			http.get(apiUrl("/sources/:id"), () => {
				detail();
				return HttpResponse.json(source());
			}),
		);
		const client = createQueryClient();
		const rows = storeEvents(50);
		const tree = (
			<>
				<Picker
					kind="source"
					projectId="prj_1"
					label="Source"
					onChange={() => {}}
				/>
				<ul>
					{rows.map((row) => (
						<li key={row.id}>
							<ResourceLabel kind="source" id={row.id} projectId="prj_1" />
						</li>
					))}
				</ul>
			</>
		);

		const first = renderWith(tree, client);
		await waitFor(() =>
			expect(screen.getAllByText("Store events")).toHaveLength(50),
		);
		expect(detail).not.toHaveBeenCalled();
		expect(list).toHaveLength(1);

		first.unmount();
		renderWith(tree, client);
		await waitFor(() =>
			expect(screen.getAllByText("Store events")).toHaveLength(50),
		);
		expect(detail).not.toHaveBeenCalled();
	});
});

describe("delegation from the existing selects", () => {
	it("keeps ProjectSelect and DestinationSelect working through the route tree", async () => {
		server.use(
			http.get(apiUrl("/projects"), () =>
				HttpResponse.json({ data: [project()], next_cursor: null }),
			),
			http.get(apiUrl("/destinations"), () =>
				HttpResponse.json({
					data: [destination({ id: "dst_2", name: "Ledger" })],
					next_cursor: null,
				}),
			),
		);
		renderApp("/failures?project_id=prj_1&destination_id=dst_2");

		await waitFor(() =>
			expect(screen.getByLabelText("Project")).toHaveTextContent("Payments"),
		);
		expect(screen.getByLabelText("Destination")).toHaveTextContent("Ledger");
	});
});
