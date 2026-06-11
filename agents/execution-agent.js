'use strict';

const { chromium } = require('@playwright/test');
const path    = require('path');
const fs      = require('fs');
const chalk   = require('chalk');
const { createClient, resolveModel } = require('../lib/openai-client');
const HtmlReporter = require('../reporters/html-reporter');

const MAX_RETRIES   = 3;
const RETRY_BACKOFF = 600; // ms base — multiplied by attempt index

class ExecutionAgent {
  constructor({ testMatrix, runDir, runId, sessionFile, shareSession, workers, defaultTimeout, log }) {
    this.testMatrix      = testMatrix;
    this.runDir          = runDir;
    this.runId           = runId;
    this.sessionFile     = sessionFile  || path.join(runDir, 'session.json');  // load saved session if exists
    this.shareSession    = shareSession || false;   // reuse same context for all tests (for sequential flows)
    this.workers         = Math.max(1, parseInt(workers || '1', 10));
    this.defaultTimeout  = parseInt(defaultTimeout || '10000', 10);
    this.log             = log;
    this.openai          = createClient();
    this.model           = resolveModel();
  }

  async run() {
    const { testCases, targetUrl } = this.testMatrix;
    this.log.info(`Executing ${testCases.length} test cases against ${chalk.bold(targetUrl)}`);
    if (this.shareSession) this.log.info('Session sharing: ON (sequential flow mode)');

    const startAt = new Date().toISOString();
    const browser = await chromium.launch({ headless: true });

    // Shared context for session-dependent flows
    let sharedContext = null;
    if (this.shareSession) {
      const ctxOpts = {};
      if (fs.existsSync(this.sessionFile)) {
        ctxOpts.storageState = this.sessionFile;
        this.log.info(`Loaded session from: ${this.sessionFile}`);
      }
      sharedContext = await browser.newContext(ctxOpts);
    }

    // Sort by dependsOn — simple topological order
    const ordered = this._sortByDependency(testCases);
    const results = [];

    // Track test case results by ID for dependency checks
    const resultMap = {};

    for (const tc of ordered) {
      // Skip if dependency failed
      if (tc.dependsOn && resultMap[tc.dependsOn]?.status !== 'pass') {
        const skipped = this._skipResult(tc, `Skipped: dependency ${tc.dependsOn} did not pass`);
        results.push(skipped);
        resultMap[tc.id] = skipped;
        this.log.warn(`  ⊘ [${tc.id}] ${tc.title.slice(0, 55).padEnd(55)} ${chalk.gray('skipped (dependency)')}`);
        continue;
      }

      const result = await this._runTestCase(browser, sharedContext, tc, targetUrl);
      results.push(result);
      resultMap[tc.id] = result;

      const icon = result.status === 'pass' ? chalk.green('✔') : result.status === 'skip' ? chalk.gray('⊘') : chalk.red('✘');
      const retry = result.retryCount > 0 ? chalk.yellow(` (${result.retryCount} retr${result.retryCount === 1 ? 'y' : 'ies'})`) : '';
      this.log.info(`  ${icon} [${tc.id}] ${tc.title.slice(0, 55).padEnd(55)} ${chalk.gray(result.durationMs + 'ms')}${retry}`);
    }

    if (sharedContext) await sharedContext.close();
    await browser.close();

    const passed  = results.filter(r => r.status === 'pass').length;
    const failed  = results.filter(r => r.status === 'fail').length;
    const skipped = results.filter(r => r.status === 'skip').length;

    const aiSummary = await this._generateSummary(results, this.testMatrix);

    const report = {
      runId:       this.runId,
      matrixId:    this.testMatrix.requestId,
      targetUrl,
      flowType:    this.testMatrix.flowType || 'generic',
      startedAt:   startAt,
      completedAt: new Date().toISOString(),
      environment: {
        browser: 'chromium', headless: true,
        nodeVersion: process.version, platform: process.platform
      },
      summary: { total: testCases.length, passed, failed, skipped },
      results,
      aiSummary
    };

    // Generate HTML report
    try {
      const htmlPath = HtmlReporter.generate(report, this.runDir);
      report.htmlReportPath = htmlPath;
      this.log.success(`HTML report: ${chalk.bold(htmlPath)}`);
    } catch (err) {
      this.log.warn(`HTML report generation failed: ${err.message}`);
    }

    return report;
  }

  // ── SORT TEST CASES BY DEPENDENCY ────────────────────────────────────────
  _sortByDependency(testCases) {
    const map   = Object.fromEntries(testCases.map(tc => [tc.id, tc]));
    const visited = new Set();
    const result  = [];

    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      const tc = map[id];
      if (!tc) return;
      if (tc.dependsOn && map[tc.dependsOn]) visit(tc.dependsOn);
      result.push(tc);
    };

    testCases.forEach(tc => visit(tc.id));
    return result;
  }

  // ── EXECUTE ONE TEST CASE ─────────────────────────────────────────────────
  async _runTestCase(browser, sharedContext, tc, targetUrl) {
    const context    = sharedContext || await browser.newContext(this._contextOpts(tc));
    const page       = await context.newPage();
    const start      = Date.now();
    const ssDir      = path.join(this.runDir, 'screenshots');
    const networkLog = [];

    // Capture network requests for this test case
    page.on('response', async (res) => {
      try {
        if (['fetch','xhr'].includes(res.request().resourceType())) {
          networkLog.push({ url: res.url(), status: res.status(), method: res.request().method() });
        }
      } catch (_) {}
    });

    // Intercept navigation responses for statusCode assertion
    const responseMap = {};
    page.on('response', res => {
      try { responseMap[res.url()] = res.status(); } catch (_) {}
    });

    const result = {
      testCaseId:      tc.id,
      title:           tc.title,
      type:            tc.type,
      status:          'pass',
      durationMs:      0,
      retryCount:      0,
      steps:           [],
      assertions:      [],
      screenshots:     [],
      networkRequests: [],
      error:           null,
      failedStep:      null,
      failedSelector:  null
    };

    try {
      if (!tc.steps?.some(s => s.action === 'goto')) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.defaultTimeout });
      }

      for (let i = 0; i < (tc.steps || []).length; i++) {
        const step       = tc.steps[i];
        const stepResult = await this._executeStepWithRetry(page, step, tc.id, i, ssDir);
        result.steps.push(stepResult);
        result.retryCount += stepResult.attempts - 1;

        if (stepResult.status === 'fail') {
          result.status        = 'fail';
          result.failedStep    = i + 1;
          result.failedSelector = step.selector;
          result.error         = stepResult.error;
          break;
        }
      }

      if (result.status === 'pass') {
        for (const assertion of (tc.assertions || [])) {
          const ar = await this._checkAssertion(page, assertion, responseMap, networkLog);
          result.assertions.push(ar);
          if (!ar.passed) {
            result.status = 'fail';
            result.error  = `Assertion failed [${ar.type}]: expected "${ar.expected}", got "${ar.actual}"`;
          }
        }
      }

      const finalSS = path.join(ssDir, `${tc.id}-final.png`);
      await page.screenshot({ path: finalSS, fullPage: false }).catch(() => {});
      result.screenshots.push(finalSS);

    } catch (err) {
      result.status = 'fail';
      result.error  = err.message;
      const errSS = path.join(ssDir, `${tc.id}-error.png`);
      await page.screenshot({ path: errSS }).catch(() => {});
      result.screenshots.push(errSS);
    }

    result.durationMs      = Date.now() - start;
    result.networkRequests = networkLog;
    if (!sharedContext) await context.close();
    return result;
  }

  _contextOpts(tc) {
    const opts = {};
    if (tc.sessionRequired && fs.existsSync(this.sessionFile)) {
      opts.storageState = this.sessionFile;
    }
    return opts;
  }

  // ── STEP EXECUTION WITH RETRY ─────────────────────────────────────────────
  async _executeStepWithRetry(page, step, tcId, stepIndex, ssDir) {
    // Build selector candidates: primary + any fallbacks stored in the step
    const selectors = [step.selector, ...(step.fallbackSelectors || [])].filter(Boolean);
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const sel = selectors[Math.min(attempt - 1, selectors.length - 1)] || step.selector;
      const effectiveStep = { ...step, selector: sel };
      try {
        const r = await this._executeStep(page, effectiveStep, tcId, stepIndex, ssDir);
        r.attempts = attempt;
        return r;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await page.waitForTimeout(RETRY_BACKOFF * attempt).catch(() => {});
        }
      }
    }

    return {
      action:    step.action,
      selector:  step.selector,
      status:    'fail',
      error:     (lastError?.message || 'unknown error').slice(0, 300),
      attempts:  MAX_RETRIES
    };
  }

  // ── EXECUTE ONE STEP ──────────────────────────────────────────────────────
  async _executeStep(page, step, tcId, stepIndex, ssDir) {
    const timeout = step.timeout || this.defaultTimeout;
    const result  = { action: step.action, selector: step.selector, status: 'pass', error: null };

    if (step.waitFor === 'networkidle') {
      await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    } else if (step.waitFor && step.waitFor !== 'none') {
      await page.waitForSelector(step.waitFor, { timeout }).catch(() => {});
    }

    switch (step.action) {
      case 'goto':
        await page.goto(step.value || step.selector, { waitUntil: 'domcontentloaded', timeout });
        break;
      case 'fill':
        await page.fill(step.selector, step.value || '', { timeout });
        break;
      case 'click':
        await page.click(step.selector, { timeout });
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        break;
      case 'select':
        await page.selectOption(step.selector, step.value || '', { timeout });
        break;
      case 'check':
        await page.check(step.selector, { timeout });
        break;
      case 'uncheck':
        await page.uncheck(step.selector, { timeout });
        break;
      case 'hover':
        await page.hover(step.selector, { timeout });
        break;
      case 'press':
        await page.press(step.selector || 'body', step.value || 'Enter', { timeout });
        break;
      case 'scroll':
        await page.evaluate(y => window.scrollTo({ top: y, behavior: 'smooth' }), parseInt(step.value || '0', 10));
        await page.waitForTimeout(300);
        break;
      case 'wait':
        await page.waitForTimeout(parseInt(step.value || '1000', 10));
        break;
      case 'waitForSelector':
        await page.waitForSelector(step.selector, { timeout });
        break;
      default:
        this.log.warn(`Unknown action: ${step.action}`);
    }

    if (['click', 'goto'].includes(step.action)) {
      const ss = path.join(ssDir, `${tcId}-step${stepIndex + 1}.png`);
      await page.screenshot({ path: ss }).catch(() => {});
      result.screenshot = ss;
    }

    return result;
  }

  // ── ASSERTIONS ────────────────────────────────────────────────────────────
  async _checkAssertion(page, assertion, responseMap, networkLog) {
    const r = { type: assertion.type, target: assertion.target, expected: assertion.expected, passed: false, actual: null };

    try {
      switch (assertion.type) {
        case 'urlContains': {
          // LLMs sometimes put the fragment in `target` with expected="true",
          // and sometimes put it directly in `expected`. Handle both.
          const fragment = (assertion.expected === 'true' || !assertion.expected)
            ? assertion.target
            : assertion.expected;
          r.actual = page.url();
          r.passed = fragment ? page.url().includes(fragment) : false;
          break;
        }

        case 'textVisible':
        case 'textContains': {
          // LLMs sometimes put the visible text in `target` with expected="true",
          // and sometimes put it directly in `expected`. Handle both.
          const needle = (assertion.expected === 'true' || !assertion.expected)
            ? assertion.target
            : assertion.expected;
          const body = await page.textContent('body').catch(() => '');
          r.actual   = body.slice(0, 300);
          r.passed   = needle ? body.includes(needle) : false;
          break;
        }

        case 'elementVisible': {
          r.passed = await page.locator(assertion.target).isVisible({ timeout: 5000 }).catch(() => false);
          r.actual = r.passed ? 'visible' : 'not visible';
          break;
        }

        case 'elementNotVisible': {
          const vis = await page.locator(assertion.target).isVisible({ timeout: 3000 }).catch(() => false);
          r.passed  = !vis;
          r.actual  = vis ? 'visible' : 'not visible';
          break;
        }

        case 'statusCode': {
          // Use the response map collected during navigation — much more reliable than waitForResponse
          const currentUrl = page.url();
          const status     = responseMap[currentUrl] ?? Object.values(responseMap).slice(-1)[0];
          r.actual  = status != null ? String(status) : 'unknown';
          r.passed  = r.actual === String(assertion.expected);
          break;
        }

        case 'responseContains': {
          const body = await page.textContent('body').catch(() => '');
          r.actual   = body.slice(0, 300);
          r.passed   = body.includes(assertion.expected);
          break;
        }

        case 'apiCalled': {
          // Check if a network request matching assertion.target was captured
          r.passed = networkLog.some(n => n.url.includes(assertion.target));
          r.actual = r.passed ? `Found: ${networkLog.find(n => n.url.includes(assertion.target))?.url}` : 'API not called';
          break;
        }

        case 'elementText': {
          const el = page.locator(assertion.target);
          r.actual  = (await el.textContent({ timeout: 5000 }).catch(() => '')) || '';
          r.passed  = r.actual.includes(assertion.expected);
          break;
        }

        case 'inputValue': {
          const el = page.locator(assertion.target);
          r.actual  = await el.inputValue({ timeout: 5000 }).catch(() => '');
          r.passed  = r.actual === assertion.expected;
          break;
        }

        default:
          r.passed = false;
          r.actual = `unsupported assertion type: ${assertion.type}`;
      }
    } catch (err) {
      r.passed = false;
      r.actual = err.message.slice(0, 150);
    }

    return r;
  }

  // ── AI SUMMARY ────────────────────────────────────────────────────────────
  async _generateSummary(results, matrix) {
    const passed  = results.filter(r => r.status === 'pass');
    const failed  = results.filter(r => r.status === 'fail');
    const skipped = results.filter(r => r.status === 'skip');

    const prompt = `You are a QA lead reviewing automated test execution results. Write a concise 3-4 paragraph summary.

## Test Run
- URL: ${matrix.targetUrl}
- Flow Type: ${matrix.flowType || 'generic'}
- Objective: ${matrix.objective}
- Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length} | Skipped: ${skipped.length}

## Failures
${failed.map(f => `- [${f.testCaseId}] ${f.title}: ${f.error}`).join('\n') || 'None — all tests passed'}

## Instructions
1. State the overall pass rate and what it means for feature quality
2. Identify failure patterns (selector issues? validation gaps? navigation problems? API errors?)
3. Recommend 2-3 specific next actions (fix selectors, add test coverage, re-run after fix)
4. Note any security or regression risks evident from the failures

Plain text only, no markdown, keep it actionable.`;

    try {
      const resp = await this.openai.chat.completions.create({
        model:    this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500, temperature: 0.3
      });
      return resp.choices[0].message.content.trim();
    } catch (err) {
      return `Summary unavailable: ${err.message}`;
    }
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────
  _skipResult(tc, reason) {
    return {
      testCaseId: tc.id, title: tc.title, type: tc.type,
      status: 'skip', durationMs: 0, retryCount: 0,
      steps: [], assertions: [], screenshots: [], networkRequests: [],
      error: reason, failedStep: null, failedSelector: null
    };
  }
}

module.exports = ExecutionAgent;
