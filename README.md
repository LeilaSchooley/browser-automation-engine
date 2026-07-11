# browser-automation-engine

Shared Playwright automation engine for job-apply-ai, quicklisting-engine, and other Playwright automations.

## Features

- **Dynamic DOM discovery** — scores click targets (apply, continue, modal steps, cookies)
- **Ad overlay dismissal** — GPT sticky units, interstitials, `body[aria-hidden]` locks
- **Smart fill** — heuristic field matching + optional site mappings
- **Agent loop** — observe → classify → decide → act
- **Cloudflare handling** — auto-wait for challenges

## Install

```bash
npm install file:../browser-automation-engine
```

## Usage

```js
import { createEngine, createLogger } from "browser-automation-engine";

const engine = createEngine({
  settings: {
    agent_enabled: true,
    browser_human_behavior: true,
  },
  buildFillConfig: async (context) => ({
    fullName: context.startupName,
    email: context.email,
    websiteUrl: context.website,
    tagline: context.tagline,
    description: context.description,
  }),
  resolveFileUpload: async () => ({ ok: false }),
});

const log = engine.createLogger({ sessionId: "sub-1" });
const result = await engine.runPipeline(page, {
  url: "https://betalist.com/submit",
  context: { startupName: "Acme", email: "hi@acme.com" },
  log,
});
```

## Apps using this engine

- [job-apply-ai](../job-apply-ai) — job application automation
- [quicklisting-engine](../quicklisting-engine) — startup directory submissions

## Tests

```bash
npm install
npx playwright install chromium   # first time only
npm test                          # all tests
npm run test:unit                 # pure logic (no browser)
npm run test:fixtures             # HTML fixture + Playwright tests
```

Fixture tests load static HTML pages and verify the full chain:
**DOM inspect → step classify → action plan → clicks/uploads → smart fill → pipeline**.

Coverage includes stuck recovery, site-mapping hints, Cloudflare detection, and
`runPipeline` with the agent disabled (linear prep path).
