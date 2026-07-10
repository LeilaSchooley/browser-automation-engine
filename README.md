# @quicklisting/browser-engine

Shared Playwright automation engine extracted from job-apply-ai.

## Features

- **Dynamic DOM discovery** — scores click targets (apply, continue, modal steps, cookies)
- **Smart fill** — heuristic field matching + optional site mappings
- **Agent loop** — observe → classify → decide → act
- **Cloudflare handling** — auto-wait for challenges

## Install

```bash
npm install file:../browser-automation-engine
```

## Usage

```js
import { createEngine, createLogger } from "@quicklisting/browser-engine";

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
