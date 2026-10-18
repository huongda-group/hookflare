# Hookflare — Dashboard UI/UX Redesign

**Status:** Draft for user approval; not an implementation authorization.
**Date:** 2026-10-18
**Target:** `apps/dashboard`, including Setup and Login.
**Visitor mode:** Operate.

## 1. Intent and authority

Replace the current minimal interface with a coherent, modern, professional operations tool. Users should quickly understand delivery health, investigate a webhook, recover failed deliveries safely, and configure ingress and delivery without memorizing identifiers.

This is a frontend redesign of an existing product, not a new gateway or integration platform. Preserve working capabilities, security boundaries, shared schemas, and API contracts. `README.md`, `CLAUDE.md`, the architecture roadmap, and subsequent milestone specs remain the product authorities. Where the original root `DESIGN.md` differs, the roadmap and later milestone decisions win. Root `DESIGN.md` is a system specification and must not be replaced with visual design documentation.

### Confirmed by the user

- Redesign Setup, Login, and the dashboard as one coherent experience.
- Use **direction B: light navigation**, light content surfaces, restrained accent color, clear typography, and readable operational data.
- Desktop is primary. Mobile must support incident inspection, event detail, and recovery actions; wide tables scroll within their own region, not the page.
- Write the software spec in English, consistent with repository guidance.

### Proposed by the designer, subject to approval of this document

All exact tokens, grouping, layouts, responsive breakpoints, component behavior, and acceptance criteria below are designer decisions, not additional preferences attributed to the user. The preview established visual direction only, not every screen or interaction. Approval of this document approves these proposals as the implementation baseline.

## 2. Goals, non-goals, and anti-goals

### Goals

1. Make actionable failure states easy to distinguish from normal queueing and automatic retries.
2. Support the path Overview → Events/Failures → Event Detail → recovery while preserving filter context.
3. Replace ID memorization with named resources while retaining exact identifiers and copy actions.
4. Make initial setup, login, endpoint creation, and secret handling understandable and trustworthy.
5. Establish reusable visual tokens and interaction patterns across all existing screens and dialogs.
6. Improve keyboard access, small-screen behavior, form feedback, and loading/error recovery.

### Non-goals

- No changes to ingress, retry engine, database schema, auth protocols, deployment topology, or RBAC policy.
- No transformations, fan-out, provider-specific signature presets, workflow editor, billing, or WebSockets.
- No archive search, archive replay, browser restore tool, or new environment switcher.
- No dark theme, theme switch, internationalization platform, command palette, arbitrary global search, saved views, or drag-and-drop layout in this iteration.
- No new telemetry-derived metrics such as latency percentiles, historical comparisons, or backlog age unless already provided by a verified existing endpoint. Do not expand the API to fill a mockup.

### Anti-goals

- Attractive but ambiguous dashboards, invented health claims, misleading realtime indicators, or fabricated production numbers.
- Cosmetic permission hiding without server authorization, automatic payload fetching, or exposing secrets in URLs or persistent browser storage.
- Removing advanced configuration to make a form appear simpler.
- Treating a successful replay request as a successfully delivered webhook.

## 3. Current-state evidence

The review used graph discovery plus direct source inspection, not a full rendered audit. The user's Setup screenshot is incumbent visual evidence; the HTML preview is exploratory, not production.

| Source | Finding and consequence |
|---|---|
| `components/AppShell.tsx` | Flat navigation and `min-w-[1024px]`; introduce navigation groups and a genuinely fluid shell. |
| `pages/OverviewPage.tsx` | Eight similarly weighted tiles, simple failing-destination and recent-event lists; reorganize into health, reporting, live states, and investigation entry points. |
| `pages/EventsPage.tsx` | Source/destination IDs typed manually; replace the primary path with named pickers while preserving exact-ID entry. |
| `pages/EventDetailPage.tsx` | Headers and payload precede deliveries in one long column; prioritize delivery investigation and constrain large content. |
| `components/CursorTable.tsx` | Text-only loading/error and pointer-only row navigation; provide recoverable states and real resource links. |
| `components/PayloadPanel.tsx` | Payload reads are explicit and audited; retain this behavior. |
| `components/ReplayDialog.tsx`, `pages/FailuresPage.tsx` | Reasons, bounded selection, skipped items, and not-enqueued outcomes already exist; improve presentation without weakening safeguards. |
| `pages/SetupPage.tsx`, `pages/LoginPage.tsx` | Shared schemas, Turnstile, auth-state redirects, and field errors exist; redesign presentation around existing behavior. |
| `pages/settings/StorageTab.tsx` | Retention preview, deletion-without-files warning, backup status and manual backup exist; retain all of them. |
| `lib/queries/projects.ts`, `lib/queries/endpoints.ts` | Some picker queries read only the first 200 resources; new pickers must not imply those are exhaustive. |
| Gateway `admin/routes/events.ts`, `overview.ts` | Latest-delivery summaries contain IDs; overview mixes rollups and live counts; resolve labels without changing contracts and distinguish metric semantics. |

## 4. Product invariants

- One deployment is one environment. There is no environment filter or cross-deployment navigation.
- An **event** is the received webhook; a **delivery** is a send job; an **attempt** is an actual outbound HTTP attempt. Initial deliveries, replays, and tests remain distinguishable.
- Statuses remain `pending`, `queued`, `in_flight`, `retrying`, `paused`, `delivered`, `failed_final`, and `dead`. Human-readable labels do not change stored values.
- Event lists show the **latest delivery**, not a permanent event-wide success/failure state. A status filter must retain backend semantics, even if an older matching delivery differs from the latest summary; explain this distinction in filter help.
- Replay creates a new delivery, never overwrites prior delivery history, and requires a reason. Bulk replay is limited to 100 explicitly selected delivery IDs.
- Pausing holds deliveries without consuming attempts. Resume releases work; it does not promise immediate delivery.
- Rollup totals update every five minutes. Current delivery counts are not scoped by the historical range. `generated_at` is API response generation time, not proof of the last rollup execution.
- Success rate is delivered / (delivered + failed final + dead) for the API's selected reporting window; no terminal deliveries means unavailable, not 0% or 100%.
- Raw payload reads require permission and audit success. A redacted stored-header view is not an unredacted outbound request dump.
- Secrets are displayed only when creation/rotation returns them, then only fingerprints and overlap expiry are available. Do not imply they can be revealed later.
- Cold archives support listing and authorized download only. Data absent from hot storage must not appear recoverable through replay.
- Current source authentication is generic `none`, `hmac`, or `token`; preserve configured algorithms, encodings, prefixes, and token locations.

## 5. Visual system: direction B

### Design thesis

A light operations ledger: clear named resources, stable alignment, restrained blue actions, and explicit delivery states. The interface should feel precise rather than decorative. Setup is welcoming through explanation and spacing; operational views earn their density through hierarchy.

### Proposed tokens

| Role | Initial value / rule |
|---|---|
| Canvas | `#F8FAFB` |
| Surface | `#FFFFFF` |
| Sidebar / secondary surface | `#F0F3F5` |
| Border | `#D6DFE6` |
| Primary text | `#202831` |
| Secondary text | `#536371` |
| Action | `#246A9E`, hover `#1C567F`, white label |
| Selected navigation | `#DCE8F2` with `#215C87` text |
| Success | `#29624B` on `#EAF4EF` |
| Warning | `#855B16` on `#FCF0DD` |
| Failure | `#963B34` on `#FBEAE8` |
| Focus | A visible 2–3px blue outline with offset; verify against adjacent surfaces |

Use semantic CSS variables exposed through the existing Tailwind setup; components must not invent their own palette. Verify contrast in actual states before finalizing values: normal text ≥4.5:1, large text and meaningful non-text controls ≥3:1. These are initial design values, not a claim of measured accessibility compliance.

- System UI sans stack for interface text; existing monospace stack only for IDs, code, JSON, hashes, and measured values. No external font dependency is required.
- Body 14px desktop / 15–16px mobile, labels 12–13px, page titles 26–28px, section titles 15–16px, metadata no smaller than 12px. Use tabular numerals in tables and metrics.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48px. Related controls cluster tightly; separate sections more generously.
- Inputs/buttons 40–44px high; touch actions at least 44px. Use 6–8px control radii and 12px panel radii. Define boundaries with borders; use soft elevation only for floating menus/dialogs.
- One consistent line-icon library already compatible with the project, or minimal authored geometry. Do not add several icon packages or use emoji as icons. The preview's letter mark is provisional, not a new required logo asset.
- Status combines text with color and, where useful, an icon. Pending/queued neutral; in-flight/retrying informational or amber; paused neutral; delivered green; failed final/dead red with distinct labels.
- No decorative gradients, glass, animated counters, full-page entrance animation, or unnecessary nested cards. Respect reduced motion; short focus/hover/disclosure transitions only.

## 6. Application shell and navigation

### Desktop

Use a 224–240px light sidebar, 56–64px top bar, and fluid content with 24–32px gutters. Data screens use available width; forms use a readable maximum measure rather than stretching fields across a large monitor. Do not impose a 1024px minimum page width.

Navigation groups, retaining existing routes:

| Group | Items |
|---|---|
| Monitor | Overview `/`, Events `/events`, Failures `/failures`, Alerts `/alerts` |
| Configure | Projects `/projects`, Endpoints `/endpoints` |
| Administer | Archives `/archives`, Audit log `/audit`, Settings `/settings` |

Show active route, including its detail routes, with background plus text weight, not color alone. Account menu at the sidebar bottom contains username, role, Change password, and Log out. Password change remains available regardless of administrative role. The top bar carries breadcrumbs and page-relevant context; no nonfunctional global search field.

Project filtering is **route-local URL state**, not an invisible global singleton. Display the picker in a consistent page-header location on relevant pages, pass applicable scope into drill-down links, and clear invalid source/destination selections when project changes. No project picker on unrelated instance-wide Settings or Archives pages. Breadcrumb/back links preserve originating filters when available, with a safe route fallback for direct links.

### Mobile and intermediate sizes

- At ≥1024px show the sidebar. Below 1024px replace it with a labeled menu button and an accessible navigation drawer; same routes and permission rules.
- Below 768px use 16px gutters, stacked page actions, one-column forms/panels, and compact metrics in two columns where legible.
- At 320–430px: no document-level horizontal overflow; long IDs/URLs wrap or truncate with full value available through copy/detail. Wide tables and code panels own labeled, keyboard-scrollable overflow regions.
- The navigation drawer traps focus, closes with Escape or navigation, and restores focus to its trigger. Do not replace main navigation with a bottom bar that drops destinations.
- Mobile must support opening an alert, locating a failed delivery, viewing its attempts/payload when authorized, single replay, bounded bulk selection/replay, and pause/resume. Settings remain usable, but desktop is optimized for extensive configuration.
- Dialogs become viewport-safe sheets/full-height forms where necessary. Primary and cancel actions stay reachable without covering fields or software keyboard focus.

## 7. Shared interaction patterns

### Tables, filtering, and names

- Preserve cursor pagination and “Load more”; no page numbers, invented total counts, or global sorting based on only loaded rows.
- Columns have explicit priority. On small screens retain essential status/resource/action columns and allow horizontal inspection of the rest; never silently drop recovery actions.
- Resource names are primary, IDs secondary and copyable. Duplicate names show project/short ID. Name lookups are decoration: missing permission, deleted resource, or failed lookup falls back to the exact ID without hiding the row.
- Pickers load incrementally through existing cursor APIs, offer “Load more,” and locally filter only loaded options with that limitation stated. Include an exact-ID entry path for unloaded resources. Selected IDs from a deep link remain usable while names resolve. Do not eagerly fetch the entire installation or one detail per row; use shared bounded cache/query keys and batched list pages. Backend validation remains authoritative for typed IDs.
- Filter state stays in validated URL search params. Applying filters resets pagination and bulk selection. Browser Back/Forward restores applied filters. Mobile uses an explicit Apply/Reset filter panel; desktop applies committed selections and submitted text, not each keystroke or accidental blur.
- Every clickable resource has a real keyboard-accessible link, not only a table-row click handler. Copy/menu/checkbox interactions do not navigate the row.

### Loading, empty, and failure states

| State | Required behavior |
|---|---|
| Initial loading | Stable skeleton matching page/table geometry, accessible loading label, no fake values. |
| Background refresh | Keep existing data and selections; mark refreshing. If refresh fails, keep stale data with warning and Retry. |
| Empty installation | Explain the next authorized setup action. For read-only users explain that an admin must configure resources. |
| No filter results | Preserve filters, offer Clear filters, distinguish from no data received. |
| Initial request failure | Human-readable explanation, Retry, optional technical error code. Do not show a success/empty state. |
| More-page failure | Keep loaded rows and selection; retry only the next page. |
| 401 | Existing safe login redirect with return location; clear cached identity-sensitive data on logout. |
| 403 | Permission explanation, no protected data request retry loop. |
| 404 detail | Identify missing/unavailable resource and provide a way back; do not assume why it disappeared. |
| Mutation pending | Disable duplicate submission; meaningful verb such as “Creating…”; preserve entered data on failure. |

Use inline errors for forms and persistent task outcomes; toasts supplement rather than replace them. Announce important outcomes with restrained live regions. Do not announce every polling update.

### Forms and protected actions

- Labels remain visible. Help and errors associate via `aria-describedby`; first invalid field receives focus after submission. Use shared validation schemas; do not invent stricter client-only rules.
- Creation/edit forms use a consistent focused dialog/panel with sections. Source/destination forms may be wide on desktop and full-height on mobile. Short project/user operations use smaller dialogs. Large operational configuration remains inline on detail/settings pages.
- Warn before discarding dirty configuration. No autosave of secrets or operational policy. Pending mutations cannot be submitted twice; errors preserve edits.
- Confirm pause/resume, disabling, rotation, revocation, destructive retention changes, and replay with resource identity and consequence. Keep any existing reason requirement. Avoid vague “Are you sure?” dialogs.
- Browser clipboard failures produce an actionable explanation/selectable value, not a false “Copied.” Never automatically copy secrets.

## 8. Screen specifications

### 8.1 Setup `/setup`

At wide widths use a light two-column composition: understated Hookflare/product explanation on the left, a 360–400px focused form on the right. The selected B variant applies to this area too; no dark branding panel. On mobile remove the explanatory side panel, keep the brand, short introduction, and full form. Avoid excessive top margins that push the submit action off a small screen.

Heading: **Set up your instance**. Description: **Create the first administrator account to get started.** Fields in order: Username, Password, Confirm password, Setup token. Include show/hide controls with correct accessible names for passwords; mask setup token by default and allow deliberate reveal/copy by the user through native selection, not automatic copying. Keep username/new-password autocomplete and password-manager paste support; setup token must not be persisted.

Place the actual shared-schema password/username requirements beside their fields; confirmation stays client-only. Setup token help identifies `SETUP_TOKEN` in Worker secrets or local `.dev.vars`, with a link to repository setup guidance. Turnstile enabled shows the actual widget; disabled shows a neutral explanation that bot protection is off but the setup token is still required. Partial/misconfigured Turnstile remains a blocking server error, never a UI bypass.

Primary action: **Create admin account**, loading **Creating account…**. Preserve existing setup/auth-state logic and successful authenticated landing behavior. Already-initialized/racing setup goes to Login using existing behavior. Missing setup token configuration provides the existing actionable command guidance without exposing secret values. Validation, invalid token, rate limiting, challenge failure/expiry, auth-state load failure, and network/503 states are explicitly designed. Do not render “Turnstile off” while auth state is still unknown.

### 8.2 Login `/login`

Reuse Setup typography, form controls, light composition, and security notice treatment. Heading **Sign in to Hookflare**. Username, password with reveal, actual Turnstile if configured, and **Sign in** action. Keep generic invalid-credentials messaging and safe `next` validation. No signup, social login, email reset, or “remember me” control unsupported by the backend. Preserve challenge reset after unsuccessful submission. Return to the safe requested route after success; default Overview.

### 8.3 Overview `/`

Order: title/context and project/range filters → actionable open-alert summary → reporting metrics → traffic trend with live-state summary → failing destinations → recent events. Unlike the small exploratory preview, the production design must retain the existing failing-destinations section.

- Reporting strip: Events received, Deliveries completed, Delivery success rate, Terminal failures. Terminal failures expose Failed final and Dead letter counts separately. Do not compute a fictional “undelivered events” by subtracting delivery counts from event counts.
- Label received as events and delivery outcomes as deliveries; replay can make these counts differ.
- Live summary: Pending (pending + queued + in flight, with explanation), Retrying, Paused. Independent of selected reporting period.
- Describe periodic aggregation explicitly: **Totals refresh on a five-minute rollup. Current delivery counts are queried separately.** Label response query time accurately; do not call it rollup completion time or show a green system-health dot without evidence.
- Chart plots only existing received/delivered/failed trend points, uses readable axes and legend, and has an accessible text summary. Failure rendering remains distinguishable without color alone.
- Failing destinations show name, failed and delivered counts, plus contextual links to Failures with project, destination, and supported time bounds.
- Recent events show received time, event/provider IDs, source, latest destination/status/HTTP, and an Events link. Avoid network-heavy optional enrichment; names may fall back to IDs.
- No data: use unavailable success rate and an onboarding empty state, not a chart implying activity.

### 8.4 Projects and Project Detail

Projects list retains name, slug, ID, status, created time, and authorized create/edit/disable actions. Do not promise per-project aggregates in every list row without existing data. Project detail reuses scoped Overview, shows identity/configuration, and links to its sources/destinations/events. Disable is explicit and explained; no hard-delete control for delivery history. Empty project detail offers the next authorized destination/source creation path, not a new backend wizard.

### 8.5 Endpoints, Sources, and Destinations

Retain `/endpoints` Sources/Destinations tabs and current detail URLs. Explain **Source = public intake** and **Destination = backend receiver**, with project context. Lists prioritize names and actual URLs, status, auth or delivery policy summary, and available existing stats; do not invent source-specific success metrics. Retain distinct source/destination states.

Source detail groups Overview/configuration, Authentication, Provider event ID/deduplication, Limits, and Secret fingerprint/rotation. Include ingress URL copy, target destination link, and scoped Events link. Form sections preserve name, project, destination, auth type, every auth-config field, provider event selector, body-size override, and status where supported. Existing immutable fields remain immutable: editing cannot change source auth type or project through unsupported API fields. Explain that source config can take up to 30 seconds to reach ingress. Selecting auth `none` explains the lack of source verification without silently selecting a different policy.

Destination detail groups URL/status, existing stats, delivery policy, signing secret fingerprints/overlap, and test delivery history. Retain timeout, max attempts, backoff base/max, max in flight, rate limit, and inherited default behavior. Each inherited field shows its effective default separately from the override; blank means inherit, not zero. Public HTTPS/SSRF errors stay field-level and actionable; do not suggest bypassing guards.

Pause/resume confirmation states that queued work may be held/released, no attempts are consumed while paused, and success is not immediate delivery. Test delivery uses existing synchronous behavior, displays HTTP/latency/error and its recorded test history; it is not labeled an ingress verification test. Rotation shows the one-time new secret in a protected confirmation view and preserves old-secret grace-window behavior. Credentials disappear when the view closes; reopening shows fingerprints only.

### 8.6 Events `/events`

Use one main Event ID/provider ID search input, project/source/destination named pickers, time range, status multi-select, and advanced exact HTTP code filter. `evt_…` can navigate directly. Provider event ID search requires a source; communicate that before submission, not after an unexplained empty result. Keep exact match semantics; do not imply full-text payload or wildcard search.

Table priority: Received, Event/provider ID, named source, named latest destination, Latest delivery status, HTTP, Attempts, Next retry, Size. Project context remains accessible via picker/name context; IDs always remain copyable. Filter help distinguishes matching delivery history from latest-delivery summary where necessary. Next retry shows an absolute time with relative text; overdue means scheduled time has passed, not proof the scheduler failed.

### 8.7 Event Detail `/events/:eventId`

Header: breadcrumb/back to filtered list, event ID + copy, latest-delivery summary, authorized Replay. Metadata strip: received time, project/source links, provider event ID, content type, size. A latest-delivery status never replaces the individual historical results.

Desktop uses an investigation workspace: delivery history as the primary left region (roughly 60%), request inspection as a secondary right region (roughly 40%). At narrow widths stack **delivery history before payload/headers**. Avoid forcing users past a long JSON document to reach errors.

- Deliveries ordered newest first, newest expanded by default, older items explicitly expandable. Each shows ID, kind, destination, state, creator when supplied, attempt count, and next retry/completion as applicable.
- Attempts within a delivery are chronological; show attempt number, exact start time, HTTP outcome or error type, duration, and error message. Expand response snippets as plain escaped text. No invented complete response body/header view.
- Show event receipt once in event metadata; replay creation time belongs to the replay, not a repeated suggestion the event was received again.
- Request inspector provides Headers and Payload tabs. Headers remain redacted. Payload is **not fetched by opening the event or selecting its tab**: explicit **Show payload** causes the authorized audited fetch. Reuse existing per-open read behavior; no background refetch or speculative prefetch.
- Payload supports JSON/text inspection and original-byte download; binary payload explains that download is required. Keep existing large-payload safeguard; bound viewer dimensions and avoid parsing/rendering an enormous tree by default.
- Show payload hash as secondary expandable metadata with copy; do not put a long hash above investigation content.
- Viewer sees a clear permission explanation without a payload request. Missing payload distinguishes unavailable content from transient infrastructure errors. Disable replay when absence is positively known, otherwise allow server precheck to decide and explain 409 outcomes.

### 8.8 Failures and recovery

Keep **Failed final / Dead letter** tabs, project/destination/time filters, and Unresolved only. Explain Unresolved as **no successful replay**, not “never replayed.” Original rows remain historical failures even after a replay succeeds.

Rows show delivery/event IDs, destination, attempts, last outcome/error, completion, and latest replay status. Row selection uses delivery IDs, is limited to 100 across loaded rows, and clears on any filter/tab change. “Select loaded” selects only visible/loaded rows up to the cap; no “select all matching” across unseen data. Show count and limit in a persistent action bar without covering mobile content.

Replay confirmation shows selected count/target, destination context when available, reason (1–500 characters per existing validation), and the warning **Replay creates new deliveries and can trigger your backend again. Existing history is preserved.** Do not change payload or destination in the dialog.

Results remain visible: new delivery IDs and links, skipped items with reasons, paused/held state when supplied, and saved-but-not-enqueued outcome. Separate **Created / Awaiting enqueue / Skipped** from actual delivery success. Only the backend's returned counts are authoritative. Invalidate relevant event, failure, overview, and destination-stat queries after applicable mutations; do not close the result before the user can inspect partial outcomes.

### 8.9 Alerts and Alert Detail

List existing rule, resource, open/resolved state, project where available, and opened/resolved times with existing filters and pagination. Translate known rule keys into readable labels; retain a technical key in details. Do not invent severity levels or acknowledgment/manual-resolve controls unsupported by the API.

Detail leads with what happened, affected resource link, status, timestamps, relevant structured details, and notification outcomes. Retain notification channel, kind, status, tries, error and created time. Technical JSON is expandable, not the only explanation. Route users to related destination/failure views with supported scope; a displayed delivery ID must not pretend to be an exact failure-filter link if the API cannot filter by it. System alerts without project stay visible in the applicable existing scope.

### 8.10 Archives

Explain cold-storage limitations at the top. Retain day grouping, kind/status, count, size, batch error, expandable parts, and authorized downloadable part links. Show **No files** honestly for deletion-only batches. Failed/running/unverified parts are not downloadable unless the server marks them so. Add real initial loading, empty, retry, and load-more failure states. Preserve streaming same-origin downloads and payload permission checks; no caching archive content in the app for convenience.

### 8.11 Audit log

Admin-only page retaining current supported actor/action/resource/time filters and cursor pagination. Lead with actor username (not email), readable action, resource, time, and reason when supplied. Expand redacted diff/technical details inline. No edit/delete controls, secret reveal, or unsupported export. Long resource IDs remain copyable and linked only when a corresponding permitted route exists.

### 8.12 Settings, users, tokens, and account

Keep current `tab=retry|storage|alerts|users` URL values and permission-gated tabs; labels may become Retry defaults, Storage & backups, Alerting, Users & API tokens. An unavailable tab falls back to the existing permitted default. Retry defaults remain readable for permitted non-admin users; only authorized users can save.

- **Retry defaults:** preserve all supported fields/units, explain inheritance and destination overrides, save/revert feedback, and existing caching semantics. No automatic test of policies during editing.
- **Storage & backups:** separate retention, archival mode, backup configuration, latest archive run, and backup status. Preserve preview before lowering hot/failed retention. If preview fails, do not save the reduction without confirmation data. Explain that disabling archival means deletion without archive files; require an explicit consequence confirmation. Show backup disabled warning, latest verified/failed/running backup, manual backup action, and already-running conflict. A started backup is not a verified backup. No restore action; link to runbook guidance and explain the separate encryption-key responsibility.
- **Alerting:** preserve supported rule settings, allowlisted Discord/Slack/Telegram channel types, channel enable/edit/delete/test behavior where currently supported, and encrypted-config non-disclosure. Editing must not falsely show saved credentials as retrievable values.
- **Users:** retain username/role/status, supported creation/role changes/reset/disable protections and server errors. Do not invent project-scoped roles or email invitations. API token management stays attached to the existing user context and backend authority; token create/revoke and one-time display get the same safety treatment as secrets.
- **Account:** current-password/new-password flow with server-consistent rules and “wrong password” field error; that error does not trigger an expired-session redirect. Logout clears cached sensitive state and returns to Login even if the session already expired.

## 9. Permission model

The backend remains authoritative. Reuse `useCan`/`Can` and shared permission definitions, not hand-coded role-name branches. Preserve all current route-specific permissions during the redesign.

| Capability | Viewer | Operator | Admin |
|---|:---:|:---:|:---:|
| Overview, resource metadata, events/attempts, redacted headers, allowed alert/archive metadata | Yes | Yes | Yes |
| Raw payload and authorized archive download | No | Yes | Yes |
| Replay, pause/resume, test delivery | No | Yes | Yes |
| Configuration, rotation, channel administration | No | No | Yes |
| Users/tokens/settings mutations, audit access | No | No | Yes |

This table summarizes existing intended capabilities; exact shared permission mappings win if a specific route is narrower. Unauthorized actions are absent; relevant read-only sections can explain access requirements. Never issue a protected request merely to discover it will fail. A runtime role change must be handled through existing per-request authorization and updated identity state, not optimistic access assumptions.

## 10. Data, performance, and implementation boundaries

- Reuse existing API client, TanStack Query keys/invalidation, Router routes and URL validation, react-hook-form/zod schemas, and accessible component primitives. Refactor shared presentation instead of creating a parallel app.
- No backend/API/schema changes are required or authorized by this spec. When an attractive presentation needs unavailable data, use an honest omission/ID fallback, not a fabricated value or ad hoc API expansion.
- Name selectors may add frontend cursor handling and caching over existing APIs. Never interpret `limit: 200` as “all.” Keep resources scoped by project and clear incompatible selections.
- Preserve explicit existing polling intervals where present. Do not add background polling to every screen or poll hidden tabs. Avoid parallel duplicate requests for the same entity; use Query caching. On detail pages without polling retain manual refresh and post-mutation invalidation.
- Keep stale data visible on background failure; protect edited forms and selected rows from refresh resets. Do not keep payloads/secrets in localStorage, sessionStorage, URL params, analytics, or persisted query caches. One-time secret state must clear when its view closes/unmounts.
- Bound JSON preview and avoid mounting all attempt responses and all expanded histories at once. Do not introduce virtualization or a new charting package unless real measured rendering behavior requires it; component/library choice is left to the builder within the current stack.
- Add dashboard-scoped visual documentation (for example `apps/dashboard/DESIGN.md`) during implementation, referencing this spec and describing the actual implemented tokens. Preserve root `DESIGN.md` and record design-tool metadata only in app scope. `apps/dashboard/PRODUCT.md` is product context, not a replacement system specification.
- Update `CHANGELOG.md` under Unreleased when user-visible code ships, not to imply this draft has already shipped.

## 11. Accessibility and responsive acceptance

Target WCAG 2.2 AA for redesigned interfaces, with manual verification in addition to automated checks. This is an implementation target, not current certification.

- All controls labeled; logical headings and landmarks, skip-to-content link, visible focus, accessible dialogs, meaningful table headers, keyboard-operable filtering and pagination.
- Keyboard-only path covers Login/Setup, opening an event, payload disclosure, replay confirmation/results, and pause/resume. Focus returns correctly after dialogs and pagination does not unexpectedly reset position.
- Status cannot depend only on color; icon-only actions have accessible names; charts have summaries; error/help text associates with fields.
- 200% zoom and narrow layout remain usable. Verify at 1440px and 1280px desktop, 768px intermediate, 390px and 320px mobile; table/code overflow must remain localized. Verify high-content cases, not only empty forms.
- Time presentation shows the timezone explicitly in the UI, with exact timestamp accessible by focus/tap as well as hover. Default to browser-local timezone consistently and provide UTC in timestamp details. No new saved timezone preference is required.
- Test long resource names, identical names, unbroken URLs/IDs/hashes, non-UTF-8 payloads, large JSON, many delivery histories, missing resources, slow network, and empty states.

## 12. Verification and acceptance scenarios

Implementation is acceptable only when existing features remain available and the following are demonstrated:

1. Fresh instance → clear light Setup → field/server validation → first admin → authenticated dashboard; already-configured instance does not expose a second setup path.
2. Login handles safe return URLs, invalid credentials, Turnstile off/on/error/expiry, throttling, missing auth-state data, and session expiry without exposing secrets.
3. At desktop and mobile, a user can reach every permitted page and identify the current section. No page-level horizontal overflow at the specified widths.
4. Overview distinguishes event counts, delivery counts, live states, unavailable success rate, aggregation cadence, open alerts, and failing destinations; values come only from real API data.
5. Events filters survive reload and Back/Forward; provider ID search explains source selection; named pickers can reach beyond 200 resources through cursor loading and allow exact-ID fallback.
6. Event Detail prioritizes attempts, distinguishes replays and original deliveries, renders response content safely, and never fetches payload before an authorized explicit request. Download preserves bytes.
7. Viewer cannot fetch payload or execute recovery/config changes; Operator can recover but not administer; Admin can configure. Direct navigation and runtime 403 are handled as well as hidden buttons.
8. Single and ≤100 bulk replay require reasons, prevent duplicate submission, preserve original history, expose partial skips/new IDs/not-enqueued/held outcomes, and do not claim delivery success from a 201.
9. Pause/resume, test delivery, endpoint editing, policy inheritance, one-time secret rotation, user/token management, and password change preserve API semantics and server constraints.
10. Storage reductions use the existing eligibility preview; archival-off consequences are explicit; backup started/running/failed/verified states remain distinct; archives do not offer replay/search.
11. Initial, background, and next-page failures have distinct recoverable UI; existing rows and selection survive a failed Load more. Empty filter results do not imply an empty installation.
12. The selected light-navigation direction is coherent across auth pages, dashboard pages, overlays, form errors, menus, charts, and status badges; no leftover fixed-width shell or isolated unstyled screen remains.

Use existing Vitest/component tests plus Playwright coverage for critical journeys, permissions, keyboard behavior, and responsive overflow. Add visual snapshots or documented desktop/mobile captures for Setup, Login, Overview, Events, Event Detail, Failures, Endpoints, Settings, and representative empty/error/dialog states. Synthetic test fixtures must not be mistaken for live product claims.

At implementation completion run repository checks: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and dashboard Playwright tests with their required local gateway/database setup. Record actual commands/results and limitations; do not deploy or operate Cloudflare resources for a UI redesign. Where a local dependency prevents a test, report it instead of claiming it passed.

## 13. Delivery sequence and decisions left to the builder

This document is the design boundary, not a task-by-task implementation plan. After user approval, create a separate implementation plan with these dependency groups:

1. Semantic tokens, primitives, fluid shell, navigation, and common data/form states.
2. Setup/Login/account flows and named resource selection.
3. Overview, Events, Event Detail, Failures/replay, and mobile recovery journeys.
4. Projects/Endpoints and configuration/secret/test flows.
5. Alerts, Archives, Audit, Settings/Users/Tokens, then cross-surface verification.

Each group must preserve existing capabilities while converging on the same design system. Do not ship only Setup and call the dashboard redesign complete. Builder choices include internal component/file organization, a compatible single icon family, exact spacing adjustments that preserve this direction, and chart implementation within the existing stack. New product behavior, backend changes, a dark theme, and removing functionality require separate approval.

## 14. Review record

- User approved direction B and desktop-first/mobile recovery scope in conversation.
- A fresh independent frontend builder-readiness review returned **“nothing important left”**: no material unanswered questions blocking implementation planning. This is a review of design clarity, not evidence that the UI has been built, rendered, or tested.
- Full specification approval is still pending. No application UI code has been implemented under this spec.
