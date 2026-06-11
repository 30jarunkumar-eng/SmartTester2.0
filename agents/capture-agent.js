'use strict';

const { chromium } = require('@playwright/test');
const path     = require('path');
const fs       = require('fs');
const chalk    = require('chalk');
const readline = require('readline');
const OpenAI   = require('openai');
const { v4: uuidv4 } = require('uuid');
const { createClient, resolveModel } = require('../lib/openai-client');

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.80');

// Selector strategies that are safe to use in Playwright
const SAFE_SELECTOR_RE = /^[^`${}\\]*$/;

class CaptureAgent {
  constructor({ url, objective, mode, runDir, runId, replay, heal, session, log }) {
    this.url         = this._validateUrl(url);
    this.objective   = objective;
    this.mode        = mode || 'record';
    this.runDir      = runDir;
    this.runId       = runId;
    this.replay      = replay !== false;
    this.heal        = heal  !== false;
    this.sessionFile = session || null;   // path to load/save session cookies
    this.log         = log;
    this.actions     = [];
    this.screenshots = [];
    this.networkLog  = [];               // captured API calls
    this.openai      = createClient();
    this.model       = resolveModel();
  }

  // ── Public entry ──────────────────────────────────────────────────────────
  async run() {
    this.log.info(`Capture mode: ${chalk.bold(this.mode)}`);

    let pkg;
    if (this.mode === 'record') {
      pkg = await this._runRecordMode();
    } else {
      pkg = await this._runScrapeMode();
    }

    if (this.replay && this.mode === 'record' && pkg.recordedActions?.length > 0) {
      this.log.info('Running replay verification...');
      pkg = await this._verifyReplay(pkg);
    }

    if (this.heal && pkg.replayVerification?.stepsFlagged > 0) {
      this.log.info('Running AI healing for flagged steps...');
      pkg = await this._healLowConfidenceSteps(pkg);
    }

    pkg.generatedScript     = this._generateTestSkeleton(pkg);
    pkg.networkRequests     = this.networkLog;
    const skelPath          = path.join(this.runDir, 'generated-test.spec.js');
    fs.writeFileSync(skelPath, pkg.generatedScript, 'utf8');
    pkg.generatedScriptPath = skelPath;

    return pkg;
  }

  // ── HEADED RECORDING ──────────────────────────────────────────────────────
  async _runRecordMode() {
    const launchOpts = { headless: false, slowMo: 40 };
    const browser    = await chromium.launch(launchOpts);

    // Load saved session if provided
    const contextOpts = {
      recordVideo: { dir: path.join(this.runDir, 'videos') }
    };
    if (this.sessionFile && fs.existsSync(this.sessionFile)) {
      try {
        contextOpts.storageState = this.sessionFile;
        this.log.info(`Loaded session from: ${this.sessionFile}`);
      } catch (_) {}
    }
    const context = await browser.newContext(contextOpts);
    const page    = await context.newPage();

    // ── Reliable IPC: expose a Node function callable from browser JS ────────
    await page.exposeFunction('__qaReport', (action) => {
      this.actions.push({ ...action, ts: Date.now() });
      if (['click', 'navigation', 'submit'].includes(action.action)) {
        // fire-and-forget screenshot
        const ssPath = path.join(this.runDir, 'screenshots', `step-${action.step}.png`);
        page.screenshot({ path: ssPath, fullPage: false })
          .then(() => { action.screenshot = ssPath; this.screenshots.push({ step: action.step, path: ssPath }); })
          .catch(() => {});
      }
      this.log.info(`  Recorded: ${chalk.cyan(action.action)} ${chalk.gray(action.selectors?.[0]?.sel || action.url || '')}`);
    });

    // ── Network interception: capture interesting API calls ───────────────
    context.on('response', async (res) => {
      try {
        const url  = res.url();
        const type = res.request().resourceType();
        if (!['fetch', 'xhr'].includes(type)) return;
        if (url.length > 2000) return;
        const entry = {
          url,
          method:  res.request().method(),
          status:  res.status(),
          type,
          ts:      Date.now()
        };
        // Only capture JSON responses; truncate body to avoid bloat
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json')) {
          try {
            const text = await res.text();
            entry.bodySnippet = text.slice(0, 400);
          } catch (_) {}
        }
        this.networkLog.push(entry);
      } catch (_) {}
    });

    // ── Inject event listeners into every page/frame load ─────────────────
    await page.addInitScript(() => {
      window.__qaStep = 0;

      // SPA navigation interception
      ['pushState', 'replaceState'].forEach(method => {
        const orig = history[method].bind(history);
        history[method] = function (...args) {
          orig(...args);
          window.dispatchEvent(new CustomEvent('__qa:spa', { detail: { url: location.href } }));
        };
      });

      function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
      }

      // Multi-strategy selector builder
      function getSelectors(el) {
        if (!el) return [];
        const s = [];
        if (el.getAttribute('data-testid')) s.push({ type: 'testid', sel: `[data-testid="${el.getAttribute('data-testid')}"]`, score: 10 });
        if (el.getAttribute('data-cy'))     s.push({ type: 'datacy', sel: `[data-cy="${el.getAttribute('data-cy')}"]`,         score: 10 });
        if (el.id)                          s.push({ type: 'id',     sel: `#${CSS.escape(el.id)}`,                             score: 9  });
        if (el.getAttribute('name'))        s.push({ type: 'name',   sel: `[name="${el.getAttribute('name')}"]`,               score: 8  });
        if (el.getAttribute('aria-label'))  s.push({ type: 'aria',   sel: `[aria-label="${el.getAttribute('aria-label')}"]`,   score: 7  });
        const txt = (el.innerText || el.textContent || '').trim().slice(0, 50);
        if (txt && !['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) s.push({ type: 'text', sel: `text=${txt}`, score: 6 });
        if (el.getAttribute('role'))        s.push({ type: 'role',   sel: `[role="${el.getAttribute('role')}"]`,               score: 5  });
        if (el.className) {
          const cls = [...el.classList].filter(c => !/active|focus|hover|ng-|v-|js-|is-/.test(c)).slice(0, 2).join('.');
          if (cls) s.push({ type: 'class', sel: `${el.tagName.toLowerCase()}.${cls}`, score: 4 });
        }
        s.push({ type: 'path', sel: cssPath(el), score: 2 });
        return s.sort((a, b) => b.score - a.score);
      }

      function cssPath(el) {
        const parts = [];
        while (el && el.nodeType === 1) {
          let seg  = el.tagName.toLowerCase();
          const p  = el.parentElement;
          if (p) {
            const same = [...p.children].filter(c => c.tagName === el.tagName);
            if (same.length > 1) seg += `:nth-child(${[...p.children].indexOf(el) + 1})`;
          }
          parts.unshift(seg);
          el = p;
          if (parts.length > 5) break;
        }
        return parts.join(' > ');
      }

      function rec(action) {
        window.__qaStep++;
        window.__qaReport({ ...action, step: window.__qaStep, url: location.href });
      }

      // Click
      document.addEventListener('click', e => {
        if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
        rec({ action: 'click', selectors: getSelectors(e.target), tagName: e.target.tagName.toLowerCase(), text: (e.target.innerText || '').trim().slice(0, 80) });
      }, true);

      // Fill (debounced 500ms)
      document.addEventListener('input', debounce(e => {
        const el = e.target;
        if (!['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;
        rec({ action: 'fill', selectors: getSelectors(el), inputType: el.type || 'text', value: el.type === 'password' ? '***REDACTED***' : el.value });
      }, 500), true);

      // Select
      document.addEventListener('change', e => {
        const el = e.target;
        if (el.tagName === 'SELECT') {
          rec({ action: 'select', selectors: getSelectors(el), value: el.value, label: el.options[el.selectedIndex]?.text });
        } else if (/checkbox|radio/.test(el.type || '')) {
          rec({ action: el.checked ? 'check' : 'uncheck', selectors: getSelectors(el) });
        }
      }, true);

      // Form submit
      document.addEventListener('submit', e => {
        rec({ action: 'submit', selectors: getSelectors(e.target), tagName: 'form' });
      }, true);

      // Significant scroll (more than 300px from last recorded position)
      let lastScrollY = 0;
      window.addEventListener('scroll', debounce(() => {
        const delta = Math.abs(window.scrollY - lastScrollY);
        if (delta > 300) {
          lastScrollY = window.scrollY;
          rec({ action: 'scroll', scrollY: window.scrollY, selectors: [] });
        }
      }, 600), { passive: true });

      // SPA navigation
      window.addEventListener('__qa:spa', e => {
        rec({ action: 'navigation', url: e.detail.url, type: 'spa', selectors: [] });
      });
    });

    // Navigate
    await page.goto(this.url, { waitUntil: 'domcontentloaded' });
    const initSS = path.join(this.runDir, 'screenshots', 'step-0-initial.png');
    await page.screenshot({ path: initSS, fullPage: true });
    this.screenshots.push({ step: 0, path: initSS, label: 'initial' });
    this.log.info(`Navigated to: ${chalk.bold(this.url)}`);
    this.log.info(chalk.yellow('Recording... Interact with the browser. Type "stop" + Enter to finish.'));
    console.log('');

    // Full-page navigations
    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      const navUrl = frame.url();
      if (navUrl === this.url || navUrl === 'about:blank') return;
      const stepNum  = this.actions.length + 1;
      const action   = { step: stepNum, action: 'navigation', url: navUrl, type: 'full', selectors: [], ts: Date.now() };
      this.actions.push(action);
      try {
        const ssPath = path.join(this.runDir, 'screenshots', `step-${stepNum}-nav.png`);
        await page.screenshot({ path: ssPath, fullPage: false });
        action.screenshot = ssPath;
      } catch (_) {}
      this.log.info(`  Navigated: ${chalk.cyan(navUrl)}`);
    });

    await this._waitForStop();

    // Final screenshot
    try {
      const finalSS = path.join(this.runDir, 'screenshots', 'step-final.png');
      await page.screenshot({ path: finalSS, fullPage: true });
      this.screenshots.push({ step: 9999, path: finalSS, label: 'final' });
    } catch (_) {}

    // Save session state — wrapped so a crashed/closed context never loses recorded actions
    try {
      const sessionDest = this.sessionFile || path.join(this.runDir, 'session.json');
      await context.storageState({ path: sessionDest });
      this.log.success(`Session saved: ${sessionDest}`);
    } catch (err) {
      this.log.warn(`Could not save session state (browser may have closed): ${err.message}`);
    }

    const pageElements = await this._extractPageElements(page).catch(() => ({ forms: [], links: [], buttons: [], iframes: [] }));
    const pageTitle    = await page.title().catch(() => '');

    // ── Emergency intermediate save — preserves recorded actions even if replay crashes ──
    const actionsSnapshot = this.actions.map(a => ({
      ...a, confidence: this._calcSelectorConfidence(a.selectors)
    }));
    const overallConfSnapshot = actionsSnapshot.length > 0
      ? actionsSnapshot.reduce((s, a) => s + (a.confidence || 1), 0) / actionsSnapshot.length : 1;
    const snapshotPkg = {
      requestId: this.runId, mode: 'record', targetUrl: this.url,
      objective: this.objective, pageTitle,
      capturedAt: new Date().toISOString(),
      overallConfidence: parseFloat(overallConfSnapshot.toFixed(3)),
      recordedActions: actionsSnapshot, pageElements, screenshots: this.screenshots,
      networkRequests: this.networkLog, _partial: true
    };
    const snapshotPath = path.join(this.runDir, 'capture-snapshot.json');
    try {
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshotPkg, null, 2), 'utf8');
      this.log.info(`Snapshot saved: capture-snapshot.json (${actionsSnapshot.length} actions)`);
    } catch (_) {}

    try { await browser.close(); } catch (_) {}

    this.log.success(`Recording stopped. ${this.actions.length} actions captured.`);

    const actionsWithConf = this.actions.map(a => ({
      ...a,
      confidence: this._calcSelectorConfidence(a.selectors)
    }));

    const overallConf = actionsWithConf.length > 0
      ? actionsWithConf.reduce((s, a) => s + (a.confidence || 1), 0) / actionsWithConf.length
      : 1;

    return {
      requestId:         this.runId,
      mode:              'record',
      targetUrl:         this.url,
      objective:         this.objective,
      pageTitle,
      capturedAt:        new Date().toISOString(),
      overallConfidence: parseFloat(overallConf.toFixed(3)),
      recordedActions:   actionsWithConf,
      pageElements,
      screenshots:       this.screenshots
    };
  }

  // ── HEADLESS SCRAPE ───────────────────────────────────────────────────────
  async _runScrapeMode() {
    this.log.info('Launching headless browser...');
    const browser  = await chromium.launch({ headless: true });
    const context  = await browser.newContext();
    const page     = await context.newPage();

    context.on('response', async (res) => {
      try {
        if (!['fetch','xhr'].includes(res.request().resourceType())) return;
        this.networkLog.push({ url: res.url(), method: res.request().method(), status: res.status(), ts: Date.now() });
      } catch (_) {}
    });

    await page.goto(this.url, { waitUntil: 'networkidle', timeout: 30000 });

    fs.mkdirSync(path.join(this.runDir, 'screenshots'), { recursive: true });
    const ssPath      = path.join(this.runDir, 'screenshots', 'step-0-initial.png');
    await page.screenshot({ path: ssPath, fullPage: true });

    const pageTitle    = await page.title();
    const pageElements = await this._extractPageElements(page);
    const autoActions  = this._autoGenerateActions(pageElements);

    try { await context.close(); } catch (_) {}
    try { await browser.close(); } catch (_) {}

    this.log.success(`Scrape complete. ${autoActions.length} actions auto-generated.`);
    return {
      requestId:         this.runId,
      mode:              'scrape',
      targetUrl:         this.url,
      objective:         this.objective,
      pageTitle,
      capturedAt:        new Date().toISOString(),
      overallConfidence: 0.88,
      recordedActions:   autoActions,
      pageElements,
      screenshots:       [{ step: 0, path: ssPath, label: 'initial' }],
      networkRequests:   this.networkLog
    };
  }

  // ── EXTRACT PAGE ELEMENTS (includes iframes) ──────────────────────────────
  async _extractPageElements(page) {
    const mainData = await page.evaluate(() => {
      const forms = [...document.querySelectorAll('form')].map(form => ({
        id:     form.id || null,
        action: form.action,
        method: form.method,
        fields: [...form.querySelectorAll('input,select,textarea')].map(el => ({
          name:        el.name || el.id || null,
          type:        el.type || el.tagName.toLowerCase(),
          id:          el.id || null,
          placeholder: el.placeholder || null,
          required:    el.required,
          label:       (document.querySelector(`label[for="${el.id}"]`) || {}).innerText?.trim() || null,
          options:     el.tagName === 'SELECT' ? [...el.options].map(o => ({ value: o.value, text: o.text })) : null,
          maxLength:   el.maxLength > 0 ? el.maxLength : null
        }))
      }));
      const links   = [...document.querySelectorAll('a[href]')]
        .slice(0, 40)
        .map(a => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 80) }))
        .filter(l => l.href && !l.href.startsWith('javascript'));
      const buttons = [...document.querySelectorAll('button,input[type=submit],input[type=button]')]
        .map(b => ({ text: (b.innerText || b.value || '').trim(), type: b.type, id: b.id || null, ariaLabel: b.getAttribute('aria-label') || null }));
      const iframes = [...document.querySelectorAll('iframe')]
        .map(f => ({ src: f.src || null, id: f.id || null, name: f.name || null }));
      return { forms, links, buttons, iframes };
    });

    // Attempt to inspect iframe contents (e.g. payment forms)
    const iframeDetails = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const url    = frame.url();
        const fields = await frame.evaluate(() =>
          [...document.querySelectorAll('input,select')].map(el => ({
            name: el.name || el.id || null, type: el.type || 'text', id: el.id || null
          }))
        ).catch(() => []);
        if (fields.length > 0) iframeDetails.push({ url, fields });
      } catch (_) {}
    }
    if (iframeDetails.length > 0) mainData.iframeContents = iframeDetails;

    return mainData;
  }

  // ── AUTO-GENERATE ACTIONS FROM SCRAPED ELEMENTS ───────────────────────────
  _autoGenerateActions(pageElements) {
    const actions = [];
    let step = 1;
    (pageElements.forms || []).forEach(form => {
      (form.fields || []).forEach(field => {
        if (['hidden','submit','button'].includes(field.type)) return;
        const sel = field.id ? `#${field.id}` : (field.name ? `[name="${field.name}"]` : null);
        if (!sel) return;
        actions.push({
          step: step++, action: 'fill',
          selectors:  [{ type: 'id', sel, score: 9 }],
          inputType:  field.type,
          value:      field.type === 'email' ? 'test@example.com' : field.type === 'password' ? '***REDACTED***' : 'test-value',
          confidence: 0.88,
          ts: Date.now()
        });
      });
      const submitBtn = (pageElements.buttons || []).find(b => b.type === 'submit');
      if (submitBtn) {
        actions.push({
          step: step++, action: 'click',
          selectors:  submitBtn.id ? [{ type: 'id', sel: `#${submitBtn.id}`, score: 9 }]
                                   : [{ type: 'text', sel: `text=${submitBtn.text}`, score: 6 }],
          text:       submitBtn.text, confidence: 0.85, ts: Date.now()
        });
      }
    });
    return actions;
  }

  // ── REPLAY VERIFICATION ───────────────────────────────────────────────────
  async _verifyReplay(pkg) {
    const browser = await chromium.launch({ headless: true });
    const page    = await browser.newPage();
    let passed = 0, flagged = 0;
    const results = [];

    await page.goto(pkg.targetUrl, { waitUntil: 'domcontentloaded' });

    for (const action of pkg.recordedActions) {
      const r = { step: action.step, action: action.action, confidence: action.confidence };
      try {
        await this._replayAction(page, action);
        r.replayStatus = 'pass'; passed++;
      } catch (err) {
        r.replayStatus = 'fail'; r.error = err.message; r.confidence = Math.min(action.confidence, 0.72); flagged++;
        this.log.warn(`  Step ${action.step} replay failed: ${err.message.slice(0, 80)}`);
      }
      results.push(r);
    }

    await browser.close();

    pkg.recordedActions = pkg.recordedActions.map(a => {
      const r = results.find(x => x.step === a.step);
      return r ? { ...a, confidence: r.confidence, replayStatus: r.replayStatus, replayError: r.error } : a;
    });

    pkg.replayVerification = {
      replayed: true, stepsTotal: pkg.recordedActions.length,
      stepsPassed: passed, stepsFlagged: flagged, completedAt: new Date().toISOString()
    };

    const avg = pkg.recordedActions.reduce((s, a) => s + (a.confidence || 1), 0) / pkg.recordedActions.length;
    pkg.overallConfidence = parseFloat(avg.toFixed(3));

    this.log.success(`Replay done: ${passed} passed, ${flagged} flagged`);
    return pkg;
  }

  async _replayAction(page, action) {
    const timeout  = 7000;
    const primary  = action.selectors?.[0]?.sel;
    if (!primary) return;

    switch (action.action) {
      case 'fill':
        await page.fill(primary, action.value === '***REDACTED***' ? 'TestPass123!' : (action.value || ''), { timeout });
        break;
      case 'click':
        await page.click(primary, { timeout });
        await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
        break;
      case 'select':
        await page.selectOption(primary, action.value, { timeout });
        break;
      case 'check':
        await page.check(primary, { timeout });
        break;
      case 'uncheck':
        await page.uncheck(primary, { timeout });
        break;
      case 'scroll':
        await page.evaluate(y => window.scrollTo(0, y), action.scrollY || 0);
        break;
      case 'navigation':
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
        break;
    }
  }

  // ── AI HEALING ────────────────────────────────────────────────────────────
  async _healLowConfidenceSteps(pkg) {
    const flagged = pkg.recordedActions.filter(a => (a.confidence || 1) < CONFIDENCE_THRESHOLD);

    for (const action of flagged) {
      try {
        const prompt = `You are a Playwright test automation expert. A recorded action failed during replay.

Action: ${JSON.stringify({ action: action.action, selectors: action.selectors, error: action.replayError }, null, 2)}

Suggest the most stable Playwright selector and any wait condition needed.
Respond ONLY as JSON (no markdown):
{
  "repairedSelector": "string",
  "selectorType": "string",
  "waitCondition": "networkidle|domcontentloaded|selector|none",
  "reasoning": "string",
  "confidence": 0.0
}`;

        const resp = await this.openai.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300, temperature: 0.1
        });

        const heal = JSON.parse(resp.choices[0].message.content.replace(/```json|```/g, '').trim());
        if (heal.repairedSelector) {
          action.selectors = [
            { type: heal.selectorType || 'ai-healed', sel: heal.repairedSelector, score: 8 },
            ...(action.selectors || [])
          ];
          action.confidence    = heal.confidence || 0.88;
          action.healingApplied = true;
          action.healingReason  = heal.reasoning;
          this.log.success(`  Healed step ${action.step}: ${heal.repairedSelector} (${(heal.confidence * 100).toFixed(0)}%)`);
        }
      } catch (err) {
        this.log.warn(`  AI healing failed for step ${action.step}: ${err.message}`);
      }
    }

    const avg = pkg.recordedActions.reduce((s, a) => s + (a.confidence || 1), 0) / pkg.recordedActions.length;
    pkg.overallConfidence = parseFloat(avg.toFixed(3));
    return pkg;
  }

  // ── GENERATE PLAYWRIGHT SKELETON (injection-safe) ─────────────────────────
  _generateTestSkeleton(pkg) {
    const actions = pkg.recordedActions || [];
    const lines = [
      `// Auto-generated — QA Multi-Agent v2`,
      `// Run  : ${pkg.requestId}`,
      `// URL  : ${pkg.targetUrl}`,
      `// Conf : ${(pkg.overallConfidence * 100).toFixed(0)}%`,
      ``,
      `const { test, expect } = require('@playwright/test');`,
      ``,
      `test.describe(${JSON.stringify('Captured: ' + pkg.objective)}, () => {`,
      `  test('should complete the recorded user journey', async ({ page }) => {`,
      `    await page.goto(${JSON.stringify(pkg.targetUrl)});`,
      ``
    ];

    for (const action of actions) {
      const sel = action.selectors?.[0]?.sel;
      if (action.healingApplied) lines.push(`    // AI-healed: ${action.healingReason}`);

      switch (action.action) {
        case 'fill':
          if (sel) {
            const val = action.value === '***REDACTED***' ? 'process.env.TEST_PASSWORD || ""' : JSON.stringify(action.value || '');
            lines.push(`    await page.fill(${JSON.stringify(sel)}, ${val});`);
          }
          break;
        case 'click':
          if (sel) {
            lines.push(`    await page.click(${JSON.stringify(sel)});`);
            if (action.replayStatus === 'fail')
              lines.push(`    await page.waitForLoadState('networkidle');`);
          }
          break;
        case 'select':
          if (sel) lines.push(`    await page.selectOption(${JSON.stringify(sel)}, ${JSON.stringify(action.value || '')});`);
          break;
        case 'check':
          if (sel) lines.push(`    await page.check(${JSON.stringify(sel)});`);
          break;
        case 'scroll':
          lines.push(`    await page.evaluate(() => window.scrollTo(0, ${action.scrollY || 0}));`);
          break;
        case 'navigation':
          lines.push(`    await page.waitForURL(${JSON.stringify(action.url)}, { timeout: 10000 }).catch(() => {});`);
          break;
        case 'submit':
          lines.push(`    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });`);
          break;
      }
      lines.push('');
    }

    lines.push(`    // Add assertions here`);
    lines.push(`    // await expect(page).toHaveURL(/expected-path/);`);
    lines.push(`    // await expect(page.locator('.success-msg')).toBeVisible();`);
    lines.push(`  });`);
    lines.push(`});`);
    return lines.join('\n');
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────
  _validateUrl(url) {
    if (!url) throw new Error('URL is required');
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https URLs are allowed');
      return url;
    } catch (err) {
      throw new Error(`Invalid URL: ${url} — ${err.message}`);
    }
  }

  _calcSelectorConfidence(selectors) {
    if (!selectors?.length) return 0.50;
    const scoreMap = { testid: 0.98, datacy: 0.98, id: 0.93, name: 0.88, aria: 0.85, text: 0.80, role: 0.78, class: 0.68, path: 0.55 };
    return scoreMap[selectors[0].type] || 0.60;
  }

  _waitForStop() {
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on('line', line => {
        if (line.trim().toLowerCase() === 'stop') {
          this.log.info('Stop signal received.');
          rl.close();
          resolve();
        }
      });
      rl.on('close', () => resolve());

      const mins = parseInt(process.env.RECORD_TIMEOUT_MINUTES || '10', 10);
      setTimeout(() => {
        this.log.warn(`Auto-stopped after ${mins} min timeout.`);
        rl.close();
        resolve();
      }, mins * 60 * 1000);
    });
  }
}

module.exports = CaptureAgent;
