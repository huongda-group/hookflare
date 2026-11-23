# Dashboard form fields

Give stacked labels and controls a consistent 8px separation throughout the dashboard. Keep the existing field names, validation, keyboard order, and inline checkbox/switch rows.

## Approaches

- A margin on the base `Label` would also affect inline labels and stack with existing spacing.
- Ad hoc spacing on each screen would leave layout decisions fragmented.
- Use a shared `FormField` for stacked labels, controls, and supporting content. Keep the existing controls and forms responsible for behavior; the wrapper standardizes layout and renders the associated label.

Use this pattern in filters, settings, dialogs, and auth. Keep standalone filters without a visible label as they are. Verify the reported screens at desktop and mobile widths and preserve setup's password toggle order.
