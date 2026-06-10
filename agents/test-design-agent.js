'use strict';

const chalk  = require('chalk');
const { createClient, resolveModel } = require('../lib/openai-client');

// Flow-type specific prompt context injected into every design request
const FLOW_CONTEXT = {
  orderFlow: `
## Flow Type: E-Commerce / Telecom Order Flow
This is a multi-step order/purchase funnel. Generate test cases that cover the COMPLETE funnel sequence:
1. Service/product availability check (address or zip code lookup)
2. Plan/product selection and comparison
3. Cart management (add, remove, update quantity)
4. Account creation or login (if required before checkout)
5. Checkout: shipping/installation address entry
6. Payment: valid card, declined card, expired card, CVV mismatch
7. Order review and confirmation
8. Post-order confirmation number display and email notification

For Verizon Home Internet specifically also cover:
- Address not in service area scenario
- Speed tier selection based on address
- Equipment selection (self-install vs technician)
- Auto-pay / paperless billing enrollment
- Promo code application (valid, invalid, expired)
- Session timeout mid-checkout recovery
`,
  accountManagement: `
## Flow Type: Account Management
Generate test cases covering authenticated account management:
1. Login (valid credentials, invalid password, locked account, MFA/2FA)
2. Account overview / dashboard data accuracy
3. Bill & payment (view current bill, pay bill, set up auto-pay)
4. Plan management (view current plan, upgrade, downgrade, add-on services)
5. Device management (view devices, add device, remove device)
6. Profile settings (change email, change password, update address)
7. Support / contact flows
8. Logout and session invalidation

For Verizon Account Management specifically also cover:
- My Verizon portal login with mobile number or email
- View and pay bill with bank account or card
- Upgrade from current plan to higher tier
- Add Verizon Home Shield or similar add-on
- Update service address
- View usage statistics
`,
  loginFlow: `
## Flow Type: Login / Authentication Flow
Generate test cases covering all authentication paths:
1. Successful login with valid credentials
2. Login failure with wrong password (verify error message)
3. Login failure with non-existent username
4. Account lockout after N failed attempts
5. Password reset (email link, SMS code)
6. Remember me / stay signed in
7. Session expiry and redirect to login
8. MFA/OTP entry (valid code, expired code, wrong code)
9. SSO / OAuth login buttons (if present)
10. CSRF protection on login form
`,
  serviceCheck: `
## Flow Type: Service Availability / Coverage Check
Generate test cases covering the service availability lookup:
1. Valid address in coverage area — verify available plans shown
2. Valid address outside coverage area — verify appropriate messaging
3. Partial address entry — verify autocomplete suggestions
4. Invalid address format — verify validation error
5. PO Box address — verify handling
6. Apartment / unit number variants
7. Multiple service tiers at same address
8. Speed/plan availability changes based on address type
9. Address in a recently expanded coverage area
`,
  generic: ''
};

class TestDesignAgent {
  constructor({ source, input, failureReport, addCases, removeIds, flowType, runDir, runId, log }) {
    this.source        = source;
    this.input         = input;
    this.failureReport = failureReport || null;
    this.addCases      = addCases      || null;
    this.removeIds     = removeIds     || [];
    this.flowType      = flowType      || 'generic';
    this.runDir        = runDir;
    this.runId         = runId;
    this.log           = log;
    this.openai        = createClient();
    this.model         = resolveModel();
  }

  async run() {
    this.log.info(`Test design source: ${chalk.bold(this.source)}  flow: ${chalk.bold(this.flowType)}`);

    let matrix;
    switch (this.source) {
      case 'capture': matrix = await this._designFromCapture();    break;
      case 'jira':    matrix = await this._designFromJira();       break;
      case 'update':  matrix = await this._updateMatrix();         break;
      default: throw new Error(`Unknown source: ${this.source}`);
    }

    this.log.success(`Generated ${matrix.testCases.length} test cases.`);
    return matrix;
  }

  // ── FROM CAPTURE PACKAGE ──────────────────────────────────────────────────
  async _designFromCapture() {
    const pkg     = this.input;
    const actions = pkg.recordedActions || [];
    const els     = pkg.pageElements    || {};
    const flowCtx = FLOW_CONTEXT[this.flowType] || '';

    const prompt = `You are a senior QA engineer. Analyze this captured browser session and generate a comprehensive test matrix.
${flowCtx}
## Captured Session
- URL: ${pkg.targetUrl}
- Objective: ${pkg.objective}
- Page title: ${pkg.pageTitle}
- Actions recorded: ${actions.length}
- Network API calls captured: ${(pkg.networkRequests || []).length}

## Recorded Actions
${JSON.stringify(actions.map(a => ({
  step: a.step, action: a.action,
  selector: a.selectors?.[0]?.sel,
  value: a.value, url: a.url
})), null, 2)}

## Page Elements
${JSON.stringify({ forms: els.forms, buttons: els.buttons?.slice(0, 10) }, null, 2)}

## Network API Calls (interesting endpoints captured)
${JSON.stringify((pkg.networkRequests || []).slice(0, 10).map(n => ({ url: n.url, method: n.method, status: n.status })), null, 2)}

## Instructions
Generate test cases covering:
1. POSITIVE: The happy path and variations with valid data
2. NEGATIVE: Invalid inputs (wrong formats, SQL injection strings "' OR 1=1 --", XSS strings "<script>alert(1)</script>")
3. BOUNDARY: Empty required fields, max-length strings, whitespace-only
4. EDGE: Rapid submission, back-button after submit, browser refresh mid-flow, session timeout

For sequential/dependent test cases, include "dependsOn": "tc-001" to indicate ordering.
For tests that require an authenticated session, include "sessionRequired": true.

Respond ONLY with valid JSON, no markdown:
{
  "version": 1,
  "sourceType": "capture",
  "flowType": "${this.flowType}",
  "requestId": "${this.runId}",
  "targetUrl": "${pkg.targetUrl}",
  "objective": "${pkg.objective}",
  "generatedAt": "${new Date().toISOString()}",
  "testCases": [
    {
      "id": "tc-001",
      "title": "string",
      "type": "positive|negative|boundary|edge",
      "priority": "high|medium|low",
      "sessionRequired": false,
      "dependsOn": null,
      "tags": ["string"],
      "steps": [
        { "action": "goto|fill|click|select|check|scroll|wait", "selector": "string or null", "value": "string or null", "waitFor": "string or null", "timeout": null }
      ],
      "assertions": [
        { "type": "urlContains|textVisible|elementVisible|elementNotVisible|textContains|apiCalled", "target": "selector or url fragment", "expected": "string" }
      ]
    }
  ]
}`;

    return this._callOpenAI(prompt, 'capture');
  }

  // ── FROM JIRA STORY ───────────────────────────────────────────────────────
  async _designFromJira() {
    const jira    = this.input;
    const flowCtx = FLOW_CONTEXT[this.flowType] || FLOW_CONTEXT[jira.flowType] || '';

    const prompt = `You are a senior QA engineer. Convert this Jira user story into a comprehensive Playwright test matrix.
${flowCtx}
## Jira Story
${JSON.stringify(jira, null, 2)}

## Instructions
Extract every acceptance criterion and generate test cases covering all scenario types.
For sequential flows, use "dependsOn" to chain test cases in execution order.
For tests that require login/session, set "sessionRequired": true.
Include realistic test data that directly exercises each AC.
Use precise, observable assertions — never vague "page loads" checks.

Respond ONLY with valid JSON, no markdown:
{
  "version": 1,
  "sourceType": "jira",
  "flowType": "${this.flowType}",
  "requestId": "${this.runId}",
  "storyId": "${jira.storyId || 'unknown'}",
  "targetUrl": "${jira.targetUrl || ''}",
  "objective": "${jira.title || (jira.description || '').slice(0, 80) || 'Jira story validation'}",
  "generatedAt": "${new Date().toISOString()}",
  "testCases": [
    {
      "id": "tc-001",
      "jiraAC": "Acceptance criterion this test covers",
      "title": "string",
      "type": "positive|negative|boundary|edge",
      "priority": "high|medium|low",
      "sessionRequired": false,
      "dependsOn": null,
      "tags": ["string"],
      "steps": [
        { "action": "goto|fill|click|select|check|scroll|wait", "selector": "string or null", "value": "string or null", "waitFor": "string or null", "timeout": null }
      ],
      "assertions": [
        { "type": "urlContains|textVisible|elementVisible|elementNotVisible|textContains|apiCalled", "target": "string", "expected": "string" }
      ]
    }
  ]
}`;

    return this._callOpenAI(prompt, 'jira');
  }

  // ── UPDATE EXISTING MATRIX ────────────────────────────────────────────────
  async _updateMatrix() {
    const existing   = this.input;
    let updateCtx    = '';

    if (this.failureReport) {
      const failed = (this.failureReport.results || []).filter(r => r.status === 'fail');
      updateCtx += `\n## Execution Failures to Address\n${JSON.stringify(failed.map(f => ({
        testId: f.testCaseId, title: f.title, error: f.error, selector: f.failedSelector
      })), null, 2)}`;
    }
    if (this.addCases) updateCtx += `\n## New Cases to Merge\n${JSON.stringify(this.addCases, null, 2)}`;
    if (this.removeIds.length) updateCtx += `\n## Remove IDs\n${this.removeIds.join(', ')}`;

    const prompt = `You are a senior QA engineer updating an existing test matrix.

## Current Matrix (v${existing.version})
- ${existing.testCases.length} test cases for: ${existing.targetUrl}
- Objective: ${existing.objective}

## Current Cases (summary)
${JSON.stringify(existing.testCases.map(t => ({ id: t.id, title: t.title, type: t.type })), null, 2)}
${updateCtx}

## Instructions
1. Remove IDs in the Remove list
2. Merge new cases without duplicating coverage
3. For each failure, generate a NEW targeted test case that specifically exercises the failure pattern
4. Increment version by 1
5. Keep all passing cases intact

Respond ONLY with the complete updated matrix JSON, no markdown:
{
  "version": ${(existing.version || 1) + 1},
  "sourceType": "update",
  "flowType": "${existing.flowType || this.flowType}",
  "requestId": "${this.runId}",
  "previousVersion": ${existing.version || 1},
  "targetUrl": "${existing.targetUrl}",
  "objective": "${existing.objective}",
  "generatedAt": "${new Date().toISOString()}",
  "testCases": []
}`;

    return this._callOpenAI(prompt, 'update', (existing.version || 1) + 1);
  }

  // ── OPENAI CALL + PARSE ───────────────────────────────────────────────────
  async _callOpenAI(prompt, sourceType, version = 1) {
    this.log.info('Calling OpenAI to generate test cases...');

    let raw;
    try {
      const resp = await this.openai.chat.completions.create({
        model:       this.model,
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  4096,
        temperature: 0.2
      });
      raw = resp.choices[0].message.content;
    } catch (err) {
      throw new Error(`OpenAI API error: ${err.message}`);
    }

    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let matrix;
    try {
      matrix = JSON.parse(cleaned);
    } catch (err) {
      throw new Error(`Failed to parse OpenAI response as JSON. Raw snippet: ${raw.slice(0, 300)}`);
    }

    matrix.version    = matrix.version    || version;
    matrix.sourceType = matrix.sourceType || sourceType;
    matrix.flowType   = matrix.flowType   || this.flowType;
    matrix.requestId  = this.runId;
    matrix.generatedAt = matrix.generatedAt || new Date().toISOString();

    if (Array.isArray(matrix.testCases)) {
      matrix.testCases = matrix.testCases.map((tc, i) => ({
        ...tc,
        id: tc.id || `tc-${String(i + 1).padStart(3, '0')}`,
        // Coerce fields that must be strings — smaller models sometimes return numbers
        steps: (tc.steps || []).map(s => ({
          ...s,
          selector:  s.selector  != null ? String(s.selector)  : null,
          value:     s.value     != null ? String(s.value)     : null,
          waitFor:   s.waitFor   != null ? String(s.waitFor)   : null
        })),
        assertions: (tc.assertions || []).map(a => ({
          ...a,
          expected: a.expected != null ? String(a.expected) : '',
          target:   a.target   != null ? String(a.target)   : null
        }))
      }));
    }

    this.log.info(`OpenAI returned ${matrix.testCases?.length || 0} test cases.`);
    return matrix;
  }
}

module.exports = TestDesignAgent;
