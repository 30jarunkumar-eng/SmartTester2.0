# SmartTester 2.0 — QA Multi-Agent Framework

> **AI-powered end-to-end test automation** — capture live browser sessions, design tests from Jira stories, or update existing matrices, then execute with Playwright and get AI-analyzed reports.

[![Node.js 18+](https://img.shields.io/badge/node-18%2B-brightgreen)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/playwright-1.x-blue)](https://playwright.dev/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

---

## What it does

SmartTester 2.0 turns three types of inputs into fully automated Playwright tests:

| Input | Path | Example |
|-------|------|---------|
| Live browser recording (headed Chromium) | **A** | Record a Verizon address check + plan selection |
| Jira user story / acceptance criteria | **B** | "Given a valid address, when I submit, then plans are shown" |
| Existing test matrix (update/heal) | **C** | Add new cases from recent execution failures |

Every stage produces a **schema-validated JSON artifact**. Artifacts are the only coupling between agents — stages can be run independently or as a full pipeline.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI  run.js                                                    │
│    --url / --jira / --update-matrix                             │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Orchestrator  orchestrator/orchestrator.js                     │
│    ● Detects input path (A / B / C)                             │
│    ● Validates every artifact with AJV JSON Schema              │
│    ● Routes stages: capture → design → execute → report         │
└──────┬───────────────────┬──────────────────────────────────────┘
       │                   │
       ▼                   ▼
┌──────────────┐   ┌───────────────────┐   ┌────────────────────┐
│ Agent 1      │   │ Agent 2           │   │ Agent 3            │
│ CaptureAgent │──▶│ TestDesignAgent   │──▶│ ExecutionAgent     │
│              │   │                   │   │                    │
│ Playwright   │   │ LLM (OpenAI /     │   │ Playwright headless│
│ headed mode  │   │  OpenRouter /     │   │ + topological sort │
│ exposeFunction│  │  NVIDIA NIM)      │   │ + retry logic      │
│ IPC bridge   │   │                   │   │ + AI summary       │
│              │   │ flowType-aware    │   │                    │
│ Output:      │   │ prompts           │   │ Output:            │
│ capture-     │   │                   │   │ execution-         │
│ package.json │   │ Output:           │   │ report.json        │
│              │   │ test-matrix.json  │   │ + HTML report      │
└──────────────┘   └───────────────────┘   └────────────────────┘
       │                   │                        │
       ▼                   ▼                        ▼
 screenshots/        schemas validated         reporters/
 videos/             at every handoff          html-reporter.js
 session.json                                       │
                                               Security scan
                                               tools/security-scan.js
```

### Input / Output per stage

```
Path A (Live Recording):
  IN:  --url https://site.com  +  human browser interaction
  OUT: capture-package.json  (recorded actions, selectors, network log, confidence scores)

Path B (Jira Story):
  IN:  --jira story.json  OR  --jira-text "AC text"
  OUT: test-matrix.json  (AI-generated test cases with steps + assertions)

Path C (Matrix Update):
  IN:  existing test-matrix.json  +  optional execution-report.json failures
  OUT: test-matrix.vN+1.json  (updated matrix, version incremented)

Stage 3 (Execution — all paths):
  IN:  test-matrix.json
  OUT: execution-report.json  +  execution-report.html
```

---

## Key Features

### Capture Agent
- **Headed recording** — `exposeFunction` IPC bridge for zero-missed events (no title-mutation polling)
- **Multi-strategy selectors** — `data-testid` › `data-cy` › `#id` › `[name]` › `[aria-label]` › `text=` › CSS path (scored 10→2)
- **Network interception** — captures XHR/fetch API calls with JSON body snippets
- **SPA support** — patches `history.pushState` / `replaceState` for React/Angular/Vue navigation
- **Session persistence** — saves cookies + localStorage via `context.storageState()`
- **Replay verification** — headless re-run assigns real confidence scores per step
- **AI healing** — LLM repairs low-confidence selectors before test design
- **Emergency snapshot** — `capture-snapshot.json` written immediately after recording stops, before any replay phase, so data is never lost
- **Scroll recording** — scroll events > 300 px threshold captured
- **iframe extraction** — inspects payment iframes for field structure

### Test Design Agent
- **flowType-aware prompts** — specialized context for `orderFlow`, `accountManagement`, `loginFlow`, `serviceCheck`
- **Verizon-specific coverage** — address availability, plan selection, cart, checkout, payment, promo codes, session timeout, auto-pay enrollment
- **Type coercion** — LLM responses returning integers for string fields are automatically coerced
- **dependsOn chaining** — test cases declare dependencies for topological execution order

### Execution Agent
- **Topological sort** — `dependsOn` field enforces correct execution order; dependent tests skip on upstream failure
- **3× retry with exponential backoff** — 600 ms base, per-step, with fallback selectors
- **Network assertion types** — `apiCalled`, `statusCode` assertions against a live response map
- **Shared session mode** — single browser context across all test cases for sequential auth flows
- **HTML report** — self-contained report with summary cards, test accordion, embedded base64 screenshots, AI analysis

### Multi-Provider LLM Support

| Provider | Env var setup | Models |
|----------|--------------|--------|
| **OpenAI** (default) | `OPENAI_API_KEY=sk-...` | `gpt-4o`, `gpt-4-turbo`, `gpt-3.5-turbo` |
| **OpenRouter** | `OPENAI_PROVIDER=openrouter` + key | `meta-llama/llama-3.1-70b-instruct:free`, `openai/gpt-4o`, `anthropic/claude-3.5-sonnet` |
| **NVIDIA NIM** | `OPENAI_PROVIDER=nvidia` + key | `meta/llama-3.1-70b-instruct`, `meta/llama-3.3-70b-instruct` |

### Security Scanner (`tools/security-scan.js`)
Scans all JSON artifacts before commit for 12 patterns:

| Code | Pattern |
|------|---------|
| SEC-001 | API key / OpenAI key exposure |
| SEC-002 | Generic secret / token patterns |
| SEC-003 | Plaintext passwords (non-redacted) |
| SEC-004 | Credit card numbers (test cards excluded) |
| SEC-005 | Real email addresses (example/test domains excluded) |
| SEC-006 | Private key material |
| SEC-007 | XSS payloads `<script>alert` |
| SEC-008 | SQL injection strings `' OR 1=1` |
| SEC-009 | Unsafe non-HTTPS URLs |
| SEC-010 | Path traversal `../../` |
| SEC-011 | Selector injection (eval, innerHTML) |
| SEC-012 | JWT tokens in artifact payloads |

---

## Prerequisites

- **Node.js 18+**
- **Windows / macOS / Linux**
- One of: OpenAI API key, OpenRouter API key, or NVIDIA NIM API key

---

## Quick Start

```powershell
# 1. Clone and install
git clone https://github.com/30jarunkumar-eng/SmartTester2.0.git
cd SmartTester2.0
npm install

# 2. Install Playwright browser
npx playwright install chromium

# 3. Configure your API key
copy .env.example .env
# Edit .env — see "Configuration" section below
```

---

## Usage

### Path A — Live browser recording

```powershell
# Full pipeline: record → design → execute
node run.js --url "https://www.verizon.com/home/internet/" --flow-type orderFlow

# Capture only (no design/execution yet)
node run.js --url "https://www.verizon.com/home/internet/" --flow-type orderFlow --stage capture --no-replay

# Design from an existing capture
node run.js --stage design --input work/runs/run-2026-06-09T20-27-48/capture-package.json --flow-type orderFlow

# Execute from an existing test matrix
node run.js --stage execute --input work/runs/run-xxx/test-matrix.json
```

**Recording walkthrough:**
1. A headed Chromium window opens on your target URL
2. Interact naturally — type, click, scroll, navigate
3. When done, type **`stop`** + Enter in the terminal
4. The agent saves `capture-package.json` with real selectors, then runs replay verification and AI healing

### Path B — From Jira story

```powershell
# From a Jira JSON file
node run.js --jira examples/verizon-home-internet/order-flow.json --flow-type orderFlow

# From inline acceptance criteria text
node run.js --jira-text "Given a valid address in the service area, when I submit, then I see available plans" --flow-type orderFlow

# Design only, skip execution
node run.js --jira examples/verizon-home-internet/order-flow.json --flow-type orderFlow --skip-execute
```

### Path C — Update existing matrix

```powershell
# Add new test cases from recent execution failures
node run.js --update-matrix --from-failures work/runs/run-xxx/execution-report.json

# Remove specific test IDs
node run.js --update-matrix --remove "tc-003,tc-007"

# Merge new cases from a JSON file
node run.js --update-matrix --add-cases new-cases.json

# Full update: heal failures + merge new cases
node run.js --update-matrix \
  --from-failures work/runs/run-xxx/execution-report.json \
  --add-cases new-cases.json \
  --remove "tc-002"
```

### Account Management flow example

```powershell
node run.js --jira examples/verizon-account-management/account-flow.json --flow-type accountManagement --share-session
```

### Advanced options

```powershell
# Shared browser session (for sequential authenticated flows)
node run.js --url https://example.com --share-session

# Custom per-step timeout (ms)
node run.js --url https://example.com --timeout 15000

# Skip replay verification after recording
node run.js --url https://example.com --stage capture --no-replay

# Skip AI healing of low-confidence steps
node run.js --url https://example.com --stage capture --no-heal

# Load existing session cookies for recording
node run.js --url https://example.com --session work/runs/run-xxx/session.json
```

### Security scan

```powershell
npm run security:scan
```

---

## Flow Types

The `--flow-type` flag injects specialized prompt context into the TestDesignAgent, producing domain-relevant test cases:

| Flow Type | Use case | Coverage |
|-----------|----------|----------|
| `orderFlow` | Telecom / e-commerce purchase funnel | Address check, plan selection, cart, checkout, payment, promo codes, confirmation |
| `accountManagement` | Authenticated account portal | Login, billing, plan upgrade, devices, profile, logout |
| `loginFlow` | Authentication / SSO | Valid login, wrong password, lockout, MFA, password reset, CSRF |
| `serviceCheck` | Coverage / availability lookup | Valid address, out-of-area, partial address, PO Box, apartment variants |
| `generic` | Any other flow | General happy path, negative, boundary, edge cases |

---

## Configuration (`.env`)

```bash
# ── API Provider (pick ONE block) ────────────────────────────

# Option A: OpenAI
OPENAI_API_KEY=sk-your-openai-key
OPENAI_MODEL=gpt-4o

# Option B: OpenRouter
# OPENAI_API_KEY=sk-or-your-openrouter-key
# OPENAI_BASE_URL=https://openrouter.ai/api/v1
# OPENAI_PROVIDER=openrouter
# OPENAI_MODEL=meta-llama/llama-3.1-70b-instruct:free

# Option C: NVIDIA NIM
# OPENAI_API_KEY=nvapi-your-nvidia-key
# OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
# OPENAI_PROVIDER=nvidia
# OPENAI_MODEL=meta/llama-3.1-70b-instruct

# ── Framework settings ────────────────────────────────────────
WORK_DIR=./work
CONFIDENCE_THRESHOLD=0.80
BROWSER=chromium
RECORD_TIMEOUT_MINUTES=10
```

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | required | API key for your chosen provider |
| `OPENAI_BASE_URL` | OpenAI default | Override for OpenRouter / NVIDIA NIM |
| `OPENAI_PROVIDER` | `openai` | `openai` \| `openrouter` \| `nvidia` |
| `OPENAI_MODEL` | `gpt-4o` | Model name (provider-specific aliases resolved automatically) |
| `WORK_DIR` | `./work` | Root directory for all run artifacts |
| `CONFIDENCE_THRESHOLD` | `0.80` | Steps below this confidence trigger AI healing |
| `BROWSER` | `chromium` | Browser for recording: `chromium` / `firefox` / `webkit` |
| `RECORD_TIMEOUT_MINUTES` | `10` | Auto-stop recording after N minutes |

---

## Output Structure

Each run creates a timestamped directory:

```
work/runs/run-2026-06-09T20-27-48/
├── capture-package.json        ← Agent 1: recorded actions, selectors, network log
├── capture-snapshot.json       ← Emergency save written immediately after recording
├── generated-test.spec.js      ← Auto-generated Playwright script skeleton
├── session.json                ← Browser cookies + localStorage (for auth replay)
├── test-matrix.json            ← Agent 2: test cases with steps + assertions
├── execution-report.json       ← Agent 3: results, screenshots, AI summary
├── execution-report.html       ← Self-contained HTML visual report
├── run-log.json                ← Pipeline stage timing log
├── screenshots/
│   ├── step-0-initial.png      ← Full-page screenshot at page load
│   ├── step-1.png              ← Screenshot after each click/submit
│   ├── step-N-nav.png          ← Screenshot after each navigation
│   └── step-final.png          ← Final state screenshot
└── videos/
    └── page@*.webm             ← Full session recording
```

---

## JSON Schema Validation

Every artifact is validated at every agent handoff using AJV:

| Schema file | Validates |
|-------------|-----------|
| `schemas/capture-package.schema.json` | CaptureAgent output |
| `schemas/test-matrix.schema.json` | TestDesignAgent output |
| `schemas/execution-report.schema.json` | ExecutionAgent output |

Validation errors halt the pipeline immediately with a clear error message pointing to the failing field.

```powershell
# Validate all JSON artifacts in the current run
npm run validate:json
```

---

## Selector Confidence Scores

The CaptureAgent scores every recorded selector:

| Selector type | Confidence | Notes |
|---------------|-----------|-------|
| `data-testid` | 98% | Most stable — test-specific attribute |
| `data-cy` | 98% | Cypress convention, equally stable |
| `#id` | 93% | Stable if IDs are not auto-generated |
| `[name=...]` | 88% | Good for form fields |
| `[aria-label=...]` | 85% | Accessibility label |
| `text=...` | 80% | Visible text content |
| `[role=...]` | 78% | ARIA role |
| CSS class chain | 68% | Fragile with dynamic class names |
| CSS path | 55% | Generated path — fragile on DOM changes |

Steps below `CONFIDENCE_THRESHOLD` (default 0.80) trigger AI healing.

---

## Project Structure

```
SmartTester2.0/
├── run.js                              ← CLI entry point (commander.js)
│
├── orchestrator/
│   └── orchestrator.js                 ← Pipeline coordinator, schema validator, URL security
│
├── agents/
│   ├── capture-agent.js                ← Playwright headed recorder + scraper + AI healer
│   ├── test-design-agent.js            ← LLM test case generator (flowType-aware)
│   └── execution-agent.js              ← Playwright runner + topological sort + retry
│
├── lib/
│   └── openai-client.js                ← Provider factory (OpenAI / OpenRouter / NVIDIA NIM)
│
├── reporters/
│   └── html-reporter.js                ← Self-contained HTML report with embedded screenshots
│
├── schemas/
│   ├── capture-package.schema.json
│   ├── test-matrix.schema.json
│   └── execution-report.schema.json
│
├── tools/
│   ├── security-scan.js                ← 12-pattern secret/PII/injection scanner
│   └── validate-json.js                ← AJV schema validator for all artifacts
│
├── prompts/
│   ├── orchestrator.md                 ← Orchestrator design notes
│   ├── agent-01-capture.md             ← Capture agent prompt documentation
│   ├── agent-02-test-design.md         ← Test design agent prompt documentation
│   └── agent-03-execution.md           ← Execution agent prompt documentation
│
├── examples/
│   ├── verizon-home-internet/
│   │   └── order-flow.json             ← Verizon Home Internet order flow Jira story
│   ├── verizon-account-management/
│   │   └── account-flow.json           ← Verizon account management Jira story
│   └── internet-login/
│       └── jira-story.json             ← Simple login flow example
│
├── playwright.config.ts
├── package.json
├── .env.example                        ← Template — copy to .env and fill in keys
└── .gitignore
```

---

## Security Principles

- **Passwords always redacted** — `***REDACTED***` in all artifacts; never plaintext
- **`.env` never committed** — excluded by `.gitignore`; only `.env.example` in repo
- **URL validation** — only `http:`/`https:` protocols accepted; file/javascript/data URIs rejected
- **Path traversal protection** — file path inputs validated against working directory
- **Selector injection prevention** — injected scripts use `JSON.stringify()` for all values
- **Credit card safety** — test cards (Stripe/Visa test numbers) excluded from security scanner
- **Email privacy** — `@example.com`, `@mailinator.com`, `@yopmail.com` domains excluded from PII scan

---

## Design Principles

- **Artifact-first** — every agent handoff is a versioned, schema-validated JSON file; no shared in-memory state between stages
- **Traceable** — every test case links back to the recorded action or Jira AC that produced it
- **Honest confidence** — replay verification assigns real measured confidence scores, not estimates
- **Failure-safe** — emergency snapshot written before replay; storageState wrapped in try-catch; retries with exponential backoff
- **Provider-agnostic** — swap LLM providers by changing three env vars; no code changes
- **Windows-friendly** — pure Node.js, no bash scripts, cross-platform `path.join()` throughout

---

## Example: Full Verizon Order Flow Run

```powershell
# Step 1: Record a live session (opens Chromium)
node run.js --url https://www.verizon.com/home/internet/ ^
            --flow-type orderFlow ^
            --stage capture ^
            --no-replay

# Step 2: Design tests from the recording
node run.js --stage design ^
            --input work/runs/run-2026-06-09T20-27-48/capture-package.json ^
            --flow-type orderFlow

# Step 3: Execute the test matrix
node run.js --stage execute ^
            --input work/runs/run-2026-06-09T20-27-48/test-matrix.json

# Or run all three stages in one command (after recording)
node run.js --url https://www.verizon.com/home/internet/ --flow-type orderFlow
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `capture-package.json` not created | Browser crashed or Ctrl+C before save | Add `--no-replay`; check `capture-snapshot.json` in run dir |
| Schema validation error on `expected must be string` | LLM returned integer for string field | Already fixed via String() coercion in TestDesignAgent |
| Tests fail with selector not found | AI-guessed selectors (Path B) don't match live DOM | Use Path A (record mode) to capture real selectors |
| `OPENAI_API_KEY is not set` | `.env` file missing or not loaded | Copy `.env.example` to `.env` and fill in your key |
| 403 on headless scrape | Site blocks headless user-agents | Use `--mode record` (headed) instead of `--mode scrape` |
| `URL is required` on `--stage execute` | Old bug (fixed in v2.0) | Update to latest — execute no longer requires `--url` |

---

## Changelog

### v2.0.0 (2026-06-09)
- **NEW** Multi-provider LLM support: OpenRouter + NVIDIA NIM via `lib/openai-client.js`
- **NEW** `flowType`-aware prompts (`orderFlow`, `accountManagement`, `loginFlow`, `serviceCheck`)
- **NEW** Verizon Home Internet + Account Management example Jira stories
- **NEW** `page.exposeFunction` IPC bridge replacing title-mutation polling
- **NEW** Network interception — XHR/fetch API calls captured in capture package
- **NEW** Topological sort for test execution order via `dependsOn` field
- **NEW** 3× retry with exponential backoff per step
- **NEW** HTML reporter with embedded base64 screenshots
- **NEW** Security scanner — 12 patterns, runs on all artifacts
- **NEW** Session persistence (cookies + localStorage) across recording and execution
- **NEW** Emergency `capture-snapshot.json` written before replay phase
- **FIX** `context.storageState()` wrapped in try-catch — recording data no longer lost on browser crash
- **FIX** Schema validation `uri` format removed — no more AJV false-positive errors
- **FIX** String coercion for LLM integer responses in assertion fields
- **FIX** `--stage execute` no longer requires `--url`
- **FIX** UUID upgraded from v10 → v11 (buffer bounds check CVE)
- **FIX** Security scanner false positives: test credit cards, example.com emails, REDACTED password patterns

### v1.0.0 (initial)
- Basic capture → design → execute pipeline
- OpenAI gpt-4o only
- Playwright headed recording
- JSON schema validation between stages

---

## License

MIT — see [LICENSE](LICENSE) for details.

> Built with [Claude Code](https://claude.ai/code) · Powered by [Playwright](https://playwright.dev/) · LLM via [NVIDIA NIM](https://developer.nvidia.com/nim) / [OpenRouter](https://openrouter.ai/) / [OpenAI](https://openai.com/)
