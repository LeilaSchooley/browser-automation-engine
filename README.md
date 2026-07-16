# @leilaschooley/browser-automation-engine

Shared Playwright automation engine for [job-apply-ai](https://github.com/LeilaSchooley/job-apply-ai), quicklisting-engine, and other Playwright automations.

Published to **GitHub Packages** (private by default).

## Features

- **Dynamic DOM discovery** — scores click targets (apply, continue, modal steps, cookies)
- **Custom controls** — combobox/listbox/contenteditable fill (`fillCustomControls`)
- **Smart fill** — heuristic field matching + site mappings + AI fallback (shared DOM core with the Smart AutoFill extension)
- **Agent loop** — observe → classify → decide → act
- **Stagehand fallback** — optional observe/act on existing Playwright `page`

## Shared smart-fill core

`src/smart_fill.js` is the source of truth for in-page field scoring/fill. The Chrome/Firefox **Smart AutoFill** extension vendors the same file as `smart-fill.js`.

```js
runSmartFill(config, siteMappings, {
  profile: "apply" | "directory" | "all",
  disabledFields: {},
  captureUndo: false,
});
```

- Hosted job apply uses `profile: "apply"` (via `smartFill.js`).
- The extension uses `profile: "all"` so one-click works for directory listings **and** job apps.

After changing `smart_fill.js`, push to `main` — CI notifies the Smart AutoFill repo and opens a PR that vendors `smart-fill.js`. No manual sync required (optional local fallback: `autofill/scripts/sync-smart-fill.sh`).

Package export: `@leilaschooley/browser-automation-engine/smart-fill`.

### Instant sync secret

Repo secret `AUTOFILL_DISPATCH_TOKEN` (PAT with `repo` on `LeilaSchooley/autofill`) enables `repository_dispatch` on every `smart_fill.js` change. Without it, autofill’s daily/manual workflow still picks up updates.

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
