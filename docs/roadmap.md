# Roadmap, design decisions, and open work

[Documentation index](README.md) · Source review: 2026-10-30. Implementation descriptions are based on this checkout; no live deployment or fresh application test result is implied.

## Business rules and current behavior

The implemented feature set spans foundation, ingress, retries, admin security, dashboard, alerts/archives, backup tooling, and built-in auth. The root package/release notes distinguish the released 1.0.0 baseline from unreleased auth/redesign work; documentation does not change release status.

Read current feature files for behavior. Milestone plans and the original system spec are historical rationale, not a second current source of truth.

## Design and interaction

Key decisions retained: one deployment per environment; one Worker with fetch/queue/scheduled handlers; D1 as the durable ledger; one source routes to one destination; authenticated global roles; original delivery history survives replay; archives verify before purge when files are enabled.

Important supersessions: built-in username/password sessions and API tokens replace Access identity; source schema/migrations replace draft milestone table names; implemented light design replaces unresolved palette proposals; actual outbound headers replace original proposed header lists.

Superseded plans and duplicate source documents have been removed from the active documentation. Keep decisions, business rules, and open work in the relevant feature page.

## Ideas, boundaries, and open work

Open acceptance: live rollback/restore/canary drills, benchmark B6 and recommended limits, and manual browser zoom verification where still marked pending in the repository.

Backlog ideas: provider presets with timestamp tolerance, per-project RBAC, restoring archived data into D1, and separating ingress deployment. Not in scope: transformations, fan-out, workflow editors, billing, and realtime WebSocket dashboards. No new feature is authorized by this documentation migration.

## Source and verification entry points

The files below define behavior and existing checks; listing a test does not mean it was run during this documentation change.

- [CHANGELOG.md](../CHANGELOG.md)
- [package.json](../package.json)
- [apps/gateway/src/admin/router.ts](../apps/gateway/src/admin/router.ts)
- [apps/gateway/src/core/db/schema.ts](../apps/gateway/src/core/db/schema.ts)

