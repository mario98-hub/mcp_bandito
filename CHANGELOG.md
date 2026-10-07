# Changelog

## Unreleased

Hosted access, text-first analysis, and an undo safety net.

- **Hosted mode with OAuth.** The server can now act as an OAuth 2.0 Resource Server: set `CONTI_OAUTH_ISSUER` + `CONTI_PUBLIC_URL` and it publishes OAuth discovery documents, validates the bearer access token issued by an external identity provider (JWT/JWKS, verified with `node:crypto` — no new dependency), and isolates each user's data. One address for everyone, login instead of a secret link, and the posture required for Claude's connector directory (OAuth, HTTPS, `Origin` validation, tool annotations). The `/mcp/<token>` secret link stays available for self-hosting and testers.
- **Multi-tenant storage.** Every row carries a `tenant`; a `Store` is bound to one tenant and `forTenant()` shares the connection and the single-writer queue. One database holds every household, isolated by tenant (the self-host / secret-link path is the `default` tenant). Pre-tenant databases are migrated in place on first open.
- **Text-first analysis.** `conti_simulate_purchase`, `conti_purchase_budget`, `conti_home_scenario` and `conti_save_home_scenario` no longer declare a UI resource, so hosts run them without an "open app" confirmation and Claude answers "can we afford…" directly in text; `conti_dashboard` stays the one tool that opens the interface.
- **Undo & delete-my-data.** Every destructive operation (deletes, import, and the new `conti_delete_all`) takes an automatic per-tenant full-state snapshot first, kept as a short undo stack; `conti_undo` restores the state from before the last one. `conti_delete_all` wipes a household for a clean slate or a privacy "delete my data" request — recoverable via `conti_undo`.

## 0.2.0

Goals and guided onboarding. A household can now set a primary goal (understand spending, emergency fund, buy a home, invest, pay off a debt, a big purchase) with an optional target amount/date and linked accounts; the overview reports each goal's progress and estimated date. New tools: `conti_onboarding` (step-by-step guided setup derived from the data), `conti_set_goal`, `conti_delete_goal`, `conti_purchase_budget` (the reverse question: how much can we spend, in cash or with financing). `conti_update_settings` can now force optional modules on/off and configure the monthly-update reminder. The dashboard view model carries onboarding state, active modules, goal progress and the purchase budget.

## 0.1.0

First public release: household setup for 1..N people, monthly snapshots, net worth after tax, savings and spending, budget, health check, home and purchase simulations, dashboard as an MCP App (EN/IT), stdio and HTTP transports, JSON import/export, importer for "Conti congiunti" artifact backups.
