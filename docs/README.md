# Hookflare documentation

Documentation is organized by feature and shared across gateway, dashboard, shared packages, and tools. Start here instead of looking for a module-specific design file. All project documentation is written in English.

## Reading scope

Read this index first, then only the feature pages relevant to the task. Open linked source/tests when exact behavior needs verification. Read runbook procedures only for deployment, recovery, or operational work; do not load the entire documentation tree by default.

## How to read and maintain these documents

- **Current behavior:** feature pages describe business rules and the checked-in implementation. Linked code/schema determines exact wire behavior; resolve drift explicitly instead of silently treating an old proposal as shipped.
- **Design:** each feature includes UI/technical decisions and links to its implementation and tests.
- **Ideas and open work:** explicitly scoped as backlog, non-goals, or pending acceptance. They are not implemented promises.
- **Operations:** use the runbook for executable deployment/recovery procedures; preserve pending drill markers.

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
| [dashboard.md](dashboard.md) | Dashboard design system |
| [operations.md](operations.md) | Deployment, operations, and verification |
| [roadmap.md](roadmap.md) | Roadmap, design decisions, and open work |

## Operations and releases

- [Operations runbook](runbook.md)
- [Release history](../CHANGELOG.md)

Keep new feature documentation here, with business rules, current behavior, design, open ideas, and source/test links. Update the relevant feature instead of creating duplicate module docs or date/milestone-led specifications. README at repository root remains the quick start; CLAUDE.md remains contributor/agent guidance.
