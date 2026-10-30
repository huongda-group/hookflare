# Reliability Console — approved UI direction

[Documentation index](README.md) · Approved by the user on 2026-10-30: “Ok rồi đó, chốt UI này”.

## Approval and visual reference

The approved browser prototype is `.superpowers/brainstorm/8574-1793346055/content/reliability-console.html`. It contains Overview and Event detail, desktop and narrow-screen compositions, attempt selection, explicit payload reveal, and a simulated replay dialog. That file is the visual reference; its synthetic content and preview-only navigation are not production requirements. Keep this reference available during implementation and review. Before moving into an isolated worktree, copy the approved prototype into the worktree's development-only reference area; do not depend on ignored files being carried by Git.

The chosen direction is **B: Reliability Console**. The user approved the mockup's appearance and interactions. The first implementation slice proposed here covers the shared shell, Overview, and Event detail. Events list, Failures, endpoint configuration, settings, and auth retain their current task layouts while inheriting shared tokens and shell; their deeper redesign is a later slice.

## Intent

Make it immediately clear which destination deserves attention, what happened to a delivery, and what recovery will do. The visual identity is carried by precise operational hierarchy and the source → delivery → attempt → outcome relationship.

## Approaches considered

- **A — Refined Admin:** smaller typography/spacing refinements to existing layouts; lower scope, weaker improvement in incident workflow.
- **B — Reliability Console (selected):** incident-first Overview, a coherent shell, and a contextual timeline/inspector detail workspace. Balances distinct design with familiar operations patterns.
- **C — Developer Workbench:** persistent list/inspector workflows and accelerators; greater interaction and responsive-design scope than the selected first slice.

## Visual contract

- Light canvas `#F7F8FA`, white content surfaces, sidebar `#F1F3F7`, foreground `#202733`, muted foreground `#667080`, border `#E3E7ED`.
- Primary action `#245BDB`; selected/navigation surfaces use the prototype's restrained blue family. Semantic red, amber and green retain textual status labels and icons.
- Use the existing system UI font stack and monospace only for technical content. No dependency or remote font is needed.
- Page title approximately 26px desktop / 24px narrow; main UI text 13–14px; supporting text 12px; compact metadata at least 11px. Preserve accessible zoom and 44px coarse-pointer hit areas.
- Desktop sidebar approximately 222px, content gutter 36px, top bar approximately 60px, panel radius 10px and control radius 7–8px. Use responsive CSS, not fixed widths that overflow. Narrow content gutters are approximately 17px.
- Reproduce the approved hierarchy, grouping, active navigation, white panel surfaces, compact metrics row and structured timeline. Retain keyboard focus, textual chart alternatives, reduced-motion behavior and real application controls.
- The development preview banner, mock snapshot time, fictitious counts, simulated account and placeholder navigation are excluded from production. Use the authenticated account and existing real routes.

## Overview

1. Consistent page header with project selection and refresh.
2. Attention section above reporting: current open-alert count and prominently surfaced destinations with failures. **Existing `failing_destinations` counts are historical within `from`/`to`, not unresolved-current counts.** Label them “Failures in selected period”; preserve destination/project/time-scoped investigation links. If there are no failures or alerts, use a factual empty state rather than asserting whole-system health.
3. One reporting surface containing received/completed/success-rate/terminal-failure metrics, a real data-driven chart, and a clearly separate current-state strip. `pending + queued + in_flight` remains the displayed pending group.
4. Retain five-minute rollup semantics and identify `generated_at` as response generation time. Range controls change query parameters and actual plotted data; daily grouping remains correct outside 24h.
5. Recent events use a readable desktop table and narrow-screen rows that keep resource context, status and received time visible together. Event links and project scope remain real. Missing names fall back to exact IDs.
6. Preserve `OverviewContent` reuse on project detail, loading/error/retry/empty states, and query-key isolation during project changes.

## Event detail

- Header: source name when available, event ID with copy, project context, current latest-delivery status and permission-aware Replay.
- Relationship strip: source, selected delivery's destination, and selected delivery's actual latest outcome. Zero deliveries and zero attempts have honest empty states.
- Multiple deliveries remain newest-first, with original/replay identity, actor, creation/receipt distinctions and independent attempt histories. The newest delivery starts expanded.
- Selecting an attempt updates the adjacent Response inspector. Selection is keyed by delivery ID and attempt ID, so attempt numbers repeated across replay deliveries never collide. Polling preserves a valid selection; event navigation resets it.
- Inspector tabs: Response, Request headers, Payload. Responses render the stored `response_snippet`, explicitly called a snippet; do not invent full response bodies, response headers, URLs or exact historical retry policy. Plain text and HTML-like responses render as text. Missing snippets have an unavailable state.
- Request headers refer to the accepted event's redacted headers, not reconstructed outbound attempt headers. Payload access retains `payload.read`, explicit reveal, bounded rendering and existing binary/download behavior.
- State-specific summaries distinguish dead/retries-exhausted, failed-final/no further automatic retry, retrying/next attempt, paused, pending, queued, in-flight and delivered. Do not claim “all attempts returned HTTP 503” unless the actual attempts establish it.
- Reuse ReplayDialog and its actual eligibility, validation and result handling. Replay creates a new delivery; creation/awaiting enqueue is not delivery success. Confirmed missing payload disables replay. Refresh and inspect resulting history without altering old deliveries.

## Existing interfaces and implementation constraints

React 19, Vite, Tailwind 4, TanStack Router/Query, Radix, lucide-react and Recharts remain the stack. No backend/schema changes are required for this slice. Existing `ResourceLabel` is cache-only; use existing resource query caches or a bounded detail lookup for the source and selected destination, retaining ID fallback when resolution fails. Name enrichment must not block event investigation or trigger one lookup per attempt.

One deployment is one environment. No environment-switcher or live connection-health promise is introduced. All product copy and repository documentation remain English.

## Acceptance

Compare production rendering against the approved reference at 1440px and 390px, plus 1024px for the sidebar transition. Prove real routing, ranges, attempt selection, replay permissions/results and explicit payload access. Cover zero-data, no-delivery, no-attempt, multiple replay deliveries, null HTTP, absent snippet, long identifiers, stale/failed metadata lookups, polling and permission-limited users. Keep the preview reference and real-data screenshots distinct.

The implementation plan is [dashboard-reliability-console-plan.md](dashboard-reliability-console-plan.md). The shared shell, Overview, and Event detail are implemented; [dashboard.md](dashboard.md) records the actual tokens and components. The prototype is a visual reference, not evidence of backend behavior. Browser acceptance and any remaining limits are recorded in the task report; fixture screenshots are not accessibility certification.
