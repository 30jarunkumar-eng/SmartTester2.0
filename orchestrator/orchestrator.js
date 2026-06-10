'use strict';

const path = require('path');
const fs   = require('fs');
const chalk = require('chalk');
const Ajv   = require('ajv');

const CaptureAgent    = require('../agents/capture-agent');
const TestDesignAgent = require('../agents/test-design-agent');
const ExecutionAgent  = require('../agents/execution-agent');

const ajv = new Ajv({ allErrors: true });

const SCHEMAS = {
  capturePackage:  require('../schemas/capture-package.schema.json'),
  testMatrix:      require('../schemas/test-matrix.schema.json'),
  executionReport: require('../schemas/execution-report.schema.json'),
};

// Permitted URL protocols for target URLs
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

class Orchestrator {
  constructor({ runId, runDir, path: detectedPath, options, log }) {
    this.runId   = runId;
    this.runDir  = runDir;
    this.path    = detectedPath;
    this.options = options;
    this.log     = log;
    this.runLog  = [];
  }

  // ── Schema validation ─────────────────────────────────────────────────────
  validate(artifact, schemaName) {
    const validate = ajv.compile(SCHEMAS[schemaName]);
    if (!validate(artifact)) {
      const errors = validate.errors.map(e => `  • ${e.instancePath} ${e.message}`).join('\n');
      throw new Error(`Schema validation failed [${schemaName}]:\n${errors}`);
    }
    return true;
  }

  // ── Security: validate user-supplied URL before any use ───────────────────
  _validateUrl(url) {
    if (!url) throw new Error('URL is required');
    let parsed;
    try { parsed = new URL(url); } catch (_) {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      throw new Error(`URL protocol not allowed: ${parsed.protocol}. Only http/https are permitted.`);
    }
    return url;
  }

  // ── Security: validate user-supplied file path ────────────────────────────
  _validateFilePath(filePath, label) {
    if (!filePath) throw new Error(`${label} file path is required`);
    const resolved = path.resolve(filePath);
    // Prevent path traversal outside of the working directory
    const cwd = process.cwd();
    if (!resolved.startsWith(cwd) && !resolved.startsWith(path.resolve(this.runDir, '..'))) {
      throw new Error(`${label} path is outside the working directory: ${resolved}`);
    }
    if (!fs.existsSync(resolved)) throw new Error(`${label} file not found: ${resolved}`);
    return resolved;
  }

  writeArtifact(filename, data) {
    const filePath = path.join(this.runDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    this.log.success(`Artifact written: ${chalk.bold(filename)}`);
    return filePath;
  }

  logStep(stage, status, detail = '') {
    const entry = { stage, status, detail, ts: new Date().toISOString() };
    this.runLog.push(entry);
    const icon = status === 'ok' ? chalk.green('✔') : chalk.red('✘');
    console.log(`  ${icon} ${chalk.bold(stage.padEnd(22))} ${detail}`);
  }

  // ── Main pipeline ─────────────────────────────────────────────────────────
  async run() {
    const { path: detectedPath, options, log } = this;

    if (detectedPath === 'A') {
      // design/execute stages don't need a URL — input file provides context
      if (options.stage === 'design')  return this._runDesign(options.input && this._validateFilePath(options.input, 'input'));
      if (options.stage === 'execute') return this._runExecute(options.input && this._validateFilePath(options.input, 'input'));

      // capture or full pipeline — URL required
      if (!options.url) throw new Error('--url is required for capture/full-pipeline runs. E.g: node run.js --url https://example.com');
      this._validateUrl(options.url);
      if (options.stage === 'capture') return this._runCapture();

      const captureFile = await this._runCapture();
      const matrixFile  = await this._runDesign(captureFile);
      if (!options.skipExecute) await this._runExecute(matrixFile);
    }

    else if (detectedPath === 'B') {
      const matrixFile = await this._runDesignFromJira();
      if (!options.skipExecute) await this._runExecute(matrixFile);
    }

    else if (detectedPath === 'C') {
      const matrixFile = await this._runMatrixUpdate();
      if (!options.skipExecute) await this._runExecute(matrixFile);
    }

    const logPath = path.join(this.runDir, 'run-log.json');
    fs.writeFileSync(logPath, JSON.stringify({ runId: this.runId, steps: this.runLog }, null, 2));
    console.log('');
    log.success(`Run log: ${chalk.bold(logPath)}`);
  }

  // ── Stage 1: Capture ──────────────────────────────────────────────────────
  async _runCapture() {
    const { options, log } = this;
    console.log('');
    console.log(chalk.bold.blue('  ┌─ STAGE 1: Capture Agent ──────────────────────────────┐'));

    const agent = new CaptureAgent({
      url:       options.url,
      objective: options.objective || `Validate ${options.url}`,
      mode:      options.mode || 'record',
      runDir:    this.runDir,
      runId:     this.runId,
      replay:    options.replay !== false,
      heal:      options.heal !== false,
      session:   options.session || null,
      log
    });

    const pkg = await agent.run();
    this.validate(pkg, 'capturePackage');
    this.logStep('capture', 'ok', `${pkg.recordedActions?.length || 0} actions, confidence ${(pkg.overallConfidence * 100).toFixed(0)}%`);
    const filePath = this.writeArtifact('capture-package.json', pkg);
    console.log(chalk.bold.blue('  └───────────────────────────────────────────────────────┘'));
    return filePath;
  }

  // ── Stage 2: Test Design (from capture) ───────────────────────────────────
  async _runDesign(captureFile) {
    const { options, log } = this;
    console.log('');
    console.log(chalk.bold.magenta('  ┌─ STAGE 2: Test Design Agent ──────────────────────────┐'));

    const capturePackage = captureFile ? JSON.parse(fs.readFileSync(captureFile, 'utf8')) : null;

    const agent = new TestDesignAgent({
      source:   'capture',
      input:    capturePackage,
      flowType: options.flowType || 'generic',
      runDir:   this.runDir,
      runId:    this.runId,
      log
    });

    const matrix = await agent.run();
    this.validate(matrix, 'testMatrix');
    this.logStep('test-design', 'ok', `${matrix.testCases.length} test cases (v${matrix.version})`);
    const filePath = this.writeArtifact('test-matrix.json', matrix);
    console.log(chalk.bold.magenta('  └───────────────────────────────────────────────────────┘'));
    return filePath;
  }

  // ── Stage 2: Test Design (from Jira) ─────────────────────────────────────
  async _runDesignFromJira() {
    const { options, log } = this;
    console.log('');
    console.log(chalk.bold.magenta('  ┌─ STAGE 2: Test Design Agent — Jira Story ─────────────┐'));

    let jiraInput;
    if (options.jira) {
      const raw = fs.readFileSync(path.resolve(options.jira), 'utf8');
      try { jiraInput = JSON.parse(raw); } catch { jiraInput = { description: raw }; }
    } else {
      jiraInput = { description: options.jiraText };
    }

    const agent = new TestDesignAgent({
      source:   'jira',
      input:    jiraInput,
      flowType: options.flowType || jiraInput.flowType || 'generic',
      runDir:   this.runDir,
      runId:    this.runId,
      log
    });

    const matrix = await agent.run();
    this.validate(matrix, 'testMatrix');
    this.logStep('test-design-jira', 'ok', `${matrix.testCases.length} test cases from Jira`);
    const filePath = this.writeArtifact('test-matrix.json', matrix);
    console.log(chalk.bold.magenta('  └───────────────────────────────────────────────────────┘'));
    return filePath;
  }

  // ── Stage 2: Matrix Update ────────────────────────────────────────────────
  async _runMatrixUpdate() {
    const { options, log } = this;
    console.log('');
    console.log(chalk.bold.magenta('  ┌─ STAGE 2: Test Design Agent — Matrix Update ───────────┐'));

    // Resolve existing matrix: explicit --matrix flag or most recent artifact
    let matrixPath;
    if (options.matrix) {
      matrixPath = this._validateFilePath(options.matrix, 'matrix');
    } else {
      const existing = this._findLatestArtifact('test-matrix', true);
      if (!existing) throw new Error('No existing test-matrix found. Provide --matrix <file>.');
      matrixPath = existing;
    }
    const existingMatrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));

    let failureReport = null;
    if (options.fromFailures) {
      failureReport = JSON.parse(fs.readFileSync(this._validateFilePath(options.fromFailures, 'fromFailures'), 'utf8'));
    }
    let addCases = null;
    if (options.addCases) {
      addCases = JSON.parse(fs.readFileSync(this._validateFilePath(options.addCases, 'addCases'), 'utf8'));
    }
    const removeIds = options.remove ? options.remove.split(',').map(s => s.trim()) : [];

    const agent = new TestDesignAgent({
      source:        'update',
      input:         existingMatrix,
      failureReport,
      addCases,
      removeIds,
      flowType:      options.flowType || existingMatrix.flowType || 'generic',
      runDir:        this.runDir,
      runId:         this.runId,
      log
    });

    const matrix = await agent.run();
    this.validate(matrix, 'testMatrix');
    this.logStep('matrix-update', 'ok', `Updated to v${matrix.version}: ${matrix.testCases.length} cases`);

    const filename = `test-matrix.v${matrix.version}.json`;
    const filePath = this.writeArtifact(filename, matrix);
    this.writeArtifact('test-matrix.json', matrix);
    console.log(chalk.bold.magenta('  └───────────────────────────────────────────────────────┘'));
    return filePath;
  }

  // ── Stage 3: Execution ────────────────────────────────────────────────────
  async _runExecute(matrixFile) {
    const { options, log } = this;
    console.log('');
    console.log(chalk.bold.yellow('  ┌─ STAGE 3: Execution Agent (Playwright) ───────────────┐'));

    const testMatrix = matrixFile
      ? JSON.parse(fs.readFileSync(matrixFile, 'utf8'))
      : JSON.parse(fs.readFileSync(this._findLatestArtifact('test-matrix'), 'utf8'));

    // Session file: --session flag or auto session.json from capture run
    const sessionFile = options.session || path.join(this.runDir, 'session.json');

    const agent = new ExecutionAgent({
      testMatrix,
      runDir:         this.runDir,
      runId:          this.runId,
      sessionFile:    sessionFile,
      shareSession:   options.shareSession  || false,
      workers:        options.workers       || 1,
      defaultTimeout: options.timeout       || 10000,
      log
    });

    const report = await agent.run();
    this.validate(report, 'executionReport');

    const passed  = report.results.filter(r => r.status === 'pass').length;
    const failed  = report.results.filter(r => r.status === 'fail').length;
    const skipped = report.results.filter(r => r.status === 'skip').length;

    this.logStep('execution', 'ok',
      `${chalk.green(passed + ' passed')}  ${chalk.red(failed + ' failed')}  ${chalk.gray(skipped + ' skipped')}`
    );

    this.writeArtifact('execution-report.json', report);
    console.log(chalk.bold.yellow('  └───────────────────────────────────────────────────────┘'));

    console.log('');
    console.log(chalk.bold('  ── Summary ─────────────────────────────────────────────'));
    console.log(`  ${chalk.green('●')} Passed : ${passed}`);
    console.log(`  ${chalk.red('●')} Failed : ${failed}`);
    console.log(`  ${chalk.gray('●')} Skipped: ${skipped}`);
    console.log('');
    if (report.aiSummary) {
      console.log(chalk.bold('  ── AI Recommendations ──────────────────────────────────'));
      report.aiSummary.split('\n').forEach(l => console.log(`  ${l}`));
    }
    console.log('');
    console.log(`  JSON Report : ${chalk.bold(path.join(this.runDir, 'execution-report.json'))}`);
    if (report.htmlReportPath) {
      console.log(`  HTML Report : ${chalk.bold(report.htmlReportPath)}`);
    }

    return report;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  _findLatestArtifact(prefix, allowMissing = false) {
    // Check runDir first, then any sibling run dirs
    const dirsToSearch = [this.runDir];
    const workRuns = path.join(this.runDir, '..'); // parent = work/runs/
    if (fs.existsSync(workRuns)) {
      const siblings = fs.readdirSync(workRuns)
        .map(d => path.join(workRuns, d))
        .filter(d => fs.statSync(d).isDirectory() && d !== this.runDir)
        .sort();
      dirsToSearch.push(...siblings.reverse()); // most recent first
    }

    for (const dir of dirsToSearch) {
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
        .sort();
      if (files.length > 0) return path.join(dir, files[files.length - 1]);
    }

    if (allowMissing) return null;
    throw new Error(`No ${prefix} artifact found in ${this.runDir}`);
  }
}

module.exports = Orchestrator;
