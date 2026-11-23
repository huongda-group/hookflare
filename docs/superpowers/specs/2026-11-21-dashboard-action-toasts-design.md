# Dashboard action toasts

Every dashboard feature should tell the user whether its API write succeeded. Show exactly one outcome toast for each dashboard `POST`, `PUT`, `DELETE`, or `PATCH` request, including setup, sign-in, and sign-out. Requests that were accepted for asynchronous work must not be presented as completed work.

Keep inline validation and errors, existing session and permission handling, and existing feedback for actions such as clipboard copy. Do not add notifications to `GET` requests or change the gateway API. Toasts must not expose request or response contents.

## Approaches

- **Shared API client (selected):** Covers both forms that call the API directly and TanStack mutations, and handles future write methods without per-feature work. Use generic outcome text and keep contextual details in each feature.
- **TanStack mutation callbacks:** Can provide operation-specific text but miss request flows that do not use mutations.
- **Per-feature handlers:** Allow tailored copy but increase duplication and make coverage easy to miss.

Mount one toast host at the router root so messages remain visible across login, setup, dashboard, and redirects. Reuse the existing permission message for failed writes; keep permission refresh and the existing read-permission notification without duplicating the write toast.
