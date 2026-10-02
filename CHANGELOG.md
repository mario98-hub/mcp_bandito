# Changelog

## 0.2.0

Goals and guided onboarding. A household can now set a primary goal (understand spending, emergency fund, buy a home, invest, pay off a debt, a big purchase) with an optional target amount/date and linked accounts; the overview reports each goal's progress and estimated date. New tools: `conti_onboarding` (step-by-step guided setup derived from the data), `conti_set_goal`, `conti_delete_goal`, `conti_purchase_budget` (the reverse question: how much can we spend, in cash or with financing). `conti_update_settings` can now force optional modules on/off and configure the monthly-update reminder. The dashboard view model carries onboarding state, active modules, goal progress and the purchase budget.

## 0.1.0

First public release: household setup for 1..N people, monthly snapshots, net worth after tax, savings and spending, budget, health check, home and purchase simulations, dashboard as an MCP App (EN/IT), stdio and HTTP transports, JSON import/export, importer for "Conti congiunti" artifact backups.
