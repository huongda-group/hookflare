# Hookflare documentation

Documentation is organized by feature and shared across gateway, dashboard, shared packages, and tools. Start here instead of looking for a module-specific design file. All project documentation is written in English.

## Reading scope

Read this index first, then only the feature pages relevant to the task. Open linked source/tests when exact behavior needs verification. Read runbook procedures only for deployment, recovery, or operational work; do not load the entire documentation tree by default.

## How to read and maintain these documents

- **Current behavior:** this directory is the canonical documentation for the checked-in implementation. Each feature has one owning page. Link to that page instead of repeating its rules. Use linked code and schema to verify exact behavior.
- **Design:** each feature includes UI/technical decisions and links to its implementation and tests.
- **Ideas and open work:** explicitly scoped as backlog, non-goals, or pending acceptance. They are not implemented promises.
- **Operations:** use the runbook for deployment, upgrades, and recovery. A source or test link is not evidence of live acceptance; preserve drill markers until a result is recorded.

For onboarding and account management, start with [login](login.md), [profile](profile.md), [users](users.md), or [API tokens](api-tokens.md). For integration, start with the [wire contract](contract.md), then follow [sources](sources.md) or [delivery](delivery.md) for lifecycle details.

## Features

| Document | Scope |
| --- | --- |
| [product.md](product.md) | Product and business model |
| [architecture.md](architecture.md) | Architecture and data model |
| [login.md](login.md) | Setup, login, and sessions |
| [profile.md](profile.md) | My account and password |
| [users.md](users.md) | Users and permissions |
| [api-tokens.md](api-tokens.md) | API tokens and automation |
| [projects.md](projects.md) | Projects |
| [sources.md](sources.md) | Sources and webhook ingress |
| [destinations.md](destinations.md) | Destinations and backend protection |
| [contract.md](contract.md) | Webhook and admin API contract |
| [delivery.md](delivery.md) | Delivery, retry, and recovery state |
| [events.md](events.md) | Events and investigation |
| [replay.md](replay.md) | Failures, replay, and test delivery |
| [overview.md](overview.md) | Overview and statistics |
| [alerts.md](alerts.md) | Alerts and notification channels |
| [archives.md](archives.md) | Archives and retention |
| [backup-restore.md](backup-restore.md) | Backups and restore |
| [settings.md](settings.md) | Settings and policy defaults |
| [audit.md](audit.md) | Audit trail |
| [dashboard.md](dashboard.md) | Reliability Console, design system, and UI verification |
| [operations.md](operations.md) | Deployment, operations, and verification |
| [roadmap.md](roadmap.md) | Open work and backlog |

## Operations and releases

- [Operations runbook](runbook.md)
- [Release index](../CHANGELOG.md): versions and release links, not feature documentation

Keep new feature documentation here, with business rules, current behavior, design rationale, open ideas, and source/test links. Record lasting decisions in the relevant feature page rather than keeping duplicate specs or task checklists after their work is done. README at repository root remains the quick start; CLAUDE.md remains contributor/agent guidance.
