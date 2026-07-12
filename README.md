# @leilaschooley/browser-automation-engine

Shared Playwright automation engine for [job-apply-ai](https://github.com/LeilaSchooley/job-apply-ai), quicklisting-engine, and other Playwright automations.

Published to **GitHub Packages** (private by default).

## Features

- **Dynamic DOM discovery** — scores click targets (apply, continue, modal steps, cookies)
- **Custom controls** — combobox/listbox/contenteditable fill (`fillCustomControls`)
- **Smart fill** — heuristic field matching + site mappings + AI fallback
- **Agent loop** — observe → classify → decide → act
- **Stagehand fallback** — optional observe/act on existing Playwright `page`

## Monorepo dev (job-apply-ai)

```bash
# from job-apply-ai root
pnpm install
pnpm run build:types
pnpm run dev:all
```

Edit `src/` here — nodemon restarts the API when engine files change.

## Install (GitHub Packages)

Add to your app `.npmrc`:

```
@leilaschooley:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Token needs `read:packages` scope.

```bash
pnpm add @leilaschooley/browser-automation-engine
```

## Usage

```js
import { createEngine, createLogger } from "@leilaschooley/browser-automation-engine";

const engine = createEngine({
  settings: { agent_enabled: true },
  buildFillConfig: async (context) => ({
    fullName: context.startupName,
    email: context.email,
  }),
});
```

## Publish

From job-apply-ai root (token needs `write:packages`):

```bash
pnpm run publish:engine
```

Or from this repo:

```bash
pnpm publish --no-git-checks
```

## Tests

```bash
pnpm install
npx playwright install chromium
pnpm test
```
