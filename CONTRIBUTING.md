# Contributing

Thanks for helping people understand their money better.

## Setup

```bash
npm install
npm test          # build + all tests
npm run preview   # dashboard in a local MCP Apps host, with demo data
```

## Principles

- **Privacy first.** No telemetry, no third-party calls from the server, no network requests from the UI beyond fonts. Data stays in the user's own SQLite file.
- **One snapshot a month.** Features must work from month-end balances and net incomes. No bank scraping, no transaction import.
- **Explain, don't decide.** Metrics and verdicts come with the reason behind them. Wording is informative, never prescriptive.
- **One engine.** All maths lives in `src/core/engine.ts` (pure functions, unit-tested) and is shared by tools and UI.
- **Bilingual.** Every user-facing string goes in `src/core/i18n.ts` in both English and Italian. New languages are welcome.

## Ideas

- More locales and currencies; country presets (capital-gains tax, mortgage rules)
- OAuth for the HTTP transport
- CSV export, per-account charts

## Pull requests

Keep them focused, add tests for engine changes, run `npm test`.
