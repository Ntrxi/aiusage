# Contributing to aiusage

Thanks for your interest in contributing! This document explains how to get involved.

## Getting Started

```bash
git clone https://github.com/juliantanx/aiusage.git
cd aiusage
pnpm install
pnpm build
```

## Development

```bash
# Start in dev mode (builds core + web, then runs CLI dev server)
pnpm dev

# Optional: start the official site on port 4000 in another terminal
pnpm dev:site

# Run tests
pnpm test

# Lint
pnpm lint
```

`pnpm dev` serves the local dashboard at `http://127.0.0.1:3847`; it does not start the official site. For local account, device-authorization, or cloud-sync development, copy `packages/cli/.env.example` to `packages/cli/.env` so the CLI uses `SITE_URL=http://localhost:4000`, then keep `pnpm dev:site` running. Remove that override to use the production site.

## Project Structure

```text
packages/
  core/     - Shared types, database schema, pricing data, utilities
  cli/      - Published CLI, parsers, local API server, sync, PM2 helpers
  web/      - Local SvelteKit dashboard bundled into the CLI
  widget/   - Electron tray/menu-bar widget
  site/     - Official website, docs, accounts, uploads, leaderboard
```

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run tests: `pnpm test`
5. Commit with a clear message following [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add new feature
   fix: resolve bug
   docs: update documentation
   ```
6. Push to your fork and open a Pull Request

## Reporting Bugs

Use the [Bug Report](https://github.com/juliantanx/aiusage/issues/new?template=bug_report.md) template. Include:

- Steps to reproduce
- Expected vs actual behavior
- OS, Node.js version, aiusage version (`aiusage status`)

## Feature Requests

Use the [Feature Request](https://github.com/juliantanx/aiusage/issues/new?template=feature_request.md) template. Describe the use case and why it matters.

## Questions?

Open a [Discussion](https://github.com/juliantanx/aiusage/discussions) or check the existing issues.
