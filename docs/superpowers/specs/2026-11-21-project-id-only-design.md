# Project ID as the only identifier

Projects keep their existing generated `prj_…` IDs. Remove the separate slug from project creation, API representations, dashboard, tooling, and the live database. Names are display labels and need not be unique.

## Approaches

- Keep the slug in storage but hide it in the dashboard: avoids a migration but leaves two identifiers and does not satisfy complete removal.
- Replace IDs with old slug values: would change URLs and require rewriting project references. It is unnecessary because routes and references already use IDs.
- Keep existing IDs and drop the slug: preserves routes and references while removing the redundant field. This is the chosen approach.

## Behavior and compatibility

- Create with `name` and optional audit `reason`; return the generated `id`, name, status, and timestamps. Keep read and update routes keyed by ID. The dashboard shows names and IDs.
- Append a Drizzle migration that removes the slug column and its unique index without changing project rows' remaining fields or their foreign-key references. Keep historical migrations and snapshots intact so previously recorded backup schemas can still be recreated before upgrading.
- Update first-party callers and documentation. Do not rewrite historical audit rows or old backup objects.
