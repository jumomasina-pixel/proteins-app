<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the Let Him Cook app. Both the **server-side Express API** (`server.js`) and the **client-side React app** (`src/App.jsx` / `src/main.jsx`) are now fully instrumented with event tracking, user identification, and exception capture.

## Summary of changes

| File | Changes |
|------|---------|
| `server.js` | Added `posthog-node` client with `enableExceptionAutocapture: true`; captures `meal_request_sent`, `meal_response_completed`, `meal_request_failed`, and `captureException` on errors. Reads `X-POSTHOG-DISTINCT-ID` / `X-POSTHOG-SESSION-ID` headers for user correlation. |
| `src/main.jsx` | Initialised `posthog-js` with project token and host from `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` env vars. |
| `src/App.jsx` | Added `posthog-js` import and capture calls throughout the component tree; user identification on onboarding completion; passes PostHog headers to API requests. |
| `.env` | Added `POSTHOG_API_KEY`, `POSTHOG_HOST`, `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`. |

## Events instrumented

| Event | Description | File |
|-------|-------------|------|
| `meal_request_sent` | Fired on the server when a user sends a request to the /api/meals endpoint | `server.js` |
| `meal_response_completed` | Fired on the server when the AI stream finishes and dishes are returned successfully | `server.js` |
| `meal_request_failed` | Fired on the server when an error occurs in the /api/meals handler | `server.js` |
| `onboarding_completed` | Fired when a user finishes the onboarding flow and submits their profile (also calls `posthog.identify`) | `src/App.jsx` |
| `dishes_received` | Fired when the client successfully parses dish suggestions from the AI response | `src/App.jsx` |
| `recipe_saved` | Fired when a user bookmarks/saves a recipe | `src/App.jsx` |
| `recipe_removed` | Fired when a user removes a saved recipe | `src/App.jsx` |
| `recipe_detail_viewed` | Fired when a user opens the detail view of a dish card | `src/App.jsx` |
| `shopping_list_copied` | Fired when a user copies the shopping list to clipboard | `src/App.jsx` |
| `chat_reset` | Fired when a user starts a new chat session | `src/App.jsx` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics dashboard](/dashboard/1617248)
- [Meal Requests Over Time](/insights/TqN2FDQm) — daily volume of AI meal requests
- [Recipe Engagement](/insights/IIec5i0u) — recipe views, saves, and shopping list copies
- [Onboarding to First Dish Funnel](/insights/gfsZ8lVA) — conversion from profile setup to receiving dish suggestions
- [Meal Request Error Rate](/insights/UsaYM6WA) — requests sent vs requests failed over time
- [Unique Active Users](/insights/yfKzIXDY) — daily unique users making meal requests

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
