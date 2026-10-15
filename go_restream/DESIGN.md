# Stream desk visual contract

One private control screen for the channel operator. Primary action is pausing
or resuming automation; secondary actions are source preview, manual selection
and fallback eligibility. Reuses the existing relay dashboard's single-page
control pattern, with an output-first hierarchy instead of log-first controls.

Dark forest neutral surfaces, pale lime accent, system sans-serif typography,
14px base text, 36px page title and 22px section titles. All palette roles and
shared spacing/radius decisions live in `internal/restream/web/app.css`.

The outgoing media sits beside broadcast status on desktop and above it on
phones. Source cards use the same 16:9 video region, status badge, title,
detail and control row. All sources use the same card template. One input
preview may play alongside output; inactive cards show an explicit slate.
No preview labels imply independent verification of Telegram delivery.

Shared primitives: primary/secondary buttons, status badge, source card,
notice/error banner, preview slate, timestamped activity row and login form.
Two-column source layout below 900px, one below 600px; output becomes stacked
below 900px. Keyboard focus remains visible and inputs have associated labels.
