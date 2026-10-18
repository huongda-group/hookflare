# Hookflare Dashboard

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

An internal administration interface for a reliable inbound webhook gateway running entirely on Cloudflare. Receive and persist events, deliver with retries, investigate failures, and replay without changing delivery history.

## Users

Viewer, Operator, and Admin are global roles. Viewers inspect metadata and delivery history; operators additionally inspect payloads and recover deliveries; admins manage configuration and users. These are repository-defined roles, not user research personas.

## Operating Context

One deployment is one environment. Users monitor overview statistics, search events, inspect delivery attempts, handle failures, configure sources and destinations, and manage alerts, archives, storage, and backups. Initial setup creates the first admin using a setup token; login uses username/password sessions. Automation uses API tokens.

## Capabilities and Constraints

Preserve React, Vite, Tailwind, and TanStack Router/Query. Preserve backend RBAC, cursor pagination, redaction, and secret-once presentation. Replay creates new deliveries, requires a reason, and bulk replay is bounded at 100. Archives can be listed and downloaded, not searched or replayed. Overview combines five-minute rollups with live counts; do not imply realtime statistics. Transformations, fan-out, workflow editors, billing, and WebSocket dashboards are out of scope.

## Brand Commitments

Name: Hookflare. The user requests a modern, professional, easy-to-use replacement UI, including Setup, Login, and dashboard. Palette and visual direction remain unapproved.

## Evidence on Hand

Repository README.md, CLAUDE.md, original root DESIGN.md, roadmap and milestone specs are product authorities. The roadmap and subsequent milestone decisions supersede the original system spec. Current dashboard source and the user's setup screenshot establish the incumbent UI. Preview statistics must be labeled illustrative.

## Product Principles

- Reliability and auditability before additional complexity.
- Make investigation and recovery understandable and safe.
- Distinguish events, deliveries, and attempts.
- Preserve existing product capabilities and security boundaries.

## Open Decisions

Visual direction, theme support, responsive scope, and detailed redesigned navigation require confirmation. This record summarizes existing repository facts and the user's confirmed redesign scope; it adds no product features.
