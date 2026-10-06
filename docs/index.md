# Conti Documentation

## Overview

Conti is an open-source MCP App that keeps a household's finances in order from one snapshot a month. This folder documents how the system is built and how to run it; for install, the tool list and configuration, see the [README](../README.md).

## Table of contents

| Document | Description |
|----------|-------------|
| [architecture.md](architecture.md) | Components, topology, the monthly data flow and the data model, with diagrams. |
| [deploy.md](deploy.md) | Running Conti for web, mobile and desktop — Render + Turso and other hosts. |

## Key components

| Component | Location | Purpose |
|-----------|----------|---------|
| Calculation engine | `src/core/engine.ts` | Pure, shared finance maths (net worth, savings, health, simulations, goals). |
| Store | `src/store/store.ts` | libSQL persistence for a local file or a remote Turso database. |
| Server | `src/server/server.ts` | MCP tools, the dashboard resource and the server identity. |
| Dashboard | `src/ui/app.ts` | The inline MCP App; recomputes the engine in the browser. |

## Related documentation

- [README](../README.md) — install, tools, configuration.
- [CHANGELOG](../CHANGELOG.md) — release notes.
- [CONTRIBUTING](../CONTRIBUTING.md) — principles and how to contribute.

---
**Last Updated:** October 2026
**Status:** Implemented
