# Header project selector

The browser-native project selector looks out of place in the dashboard header. Make both the closed control and the open list match the dashboard, without changing which project is active or what switching projects does.

## Approaches

- Restyle the native select: smaller change, but the open list still follows browser styling.
- Reuse the dashboard's shared Select (approved): consistent surface, focus treatment, and selected-item checkmark, with no new dependency.

Keep the selector before the breadcrumb. Show a small project icon, the current label, and a chevron in a compact trigger. Truncate long labels in the trigger to leave room for neighboring controls; keep full labels readable in the open list. Preserve the accessible name “Active project,” keyboard operation, the empty-selection prompt, duplicate-name disambiguation, and selection of disabled projects. Do not change routing, persistence, catalog behavior, or other Select consumers.
