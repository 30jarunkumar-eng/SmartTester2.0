#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { program } = require('commander');
const chalk  = require('chalk');
const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');

const Orchestrator = require('./orchestrator/orchestrator');
const { describeProvider } = require('./lib/openai-client');
const pkg = require('./package.json');

const log = {
  info:    m => console.log(chalk.cyan('  [INFO]  ') + m),
  success: m => console.log(chalk.green('  [PASS]  ') + m),
  warn:    m => console.log(chalk.yellow('  [WARN]  ') + m),
  error:   m => console.log(chalk.red('  [FAIL]  ') + m),
  banner:  () => {
    console.log('');
    console.log(chalk.bold.blue('  ╔══════════════════════════════════════════════════════╗'));
    console.log(chalk.bold.blue('  ║         QA Multi-Agent Framework  v2.0              ║'));
    console.log(chalk.bold.blue('  ║   Capture → Design → Execute → Report → Secure     ║'));
    console.log(chalk.bold.blue('  ╚══════════════════════════════════════════════════════╝'));
    console.log('');
  }
};

program
  .name('qa-multi-agent')
  .description('Multi-Agent QA Testing Framework — supports complex e-commerce & account management flows')
  .version(pkg.version);

program
  .command('run', { isDefault: true })
  .description('Run the full QA pipeline (capture → design → execute → report)')
  // ── Path A: Full pipeline ─────────────────────────────────────────────────
  .option('--url <url>',            'Target URL to capture and test')
  .option('--objective <text>',     'Test objective description')
  .option('--mode <mode>',          'Capture mode: record (headed) | scrape (headless)', 'record')
  .option('--stage <stage>',        'Run single stage: capture | design | execute')
  .option('--input <file>',         'Input artifact for single-stage runs')
  .option('--skip-execute',         'Stop after test design, do not execute')
  // ── Path B: Jira story ────────────────────────────────────────────────────
  .option('--jira <file>',          'Path to Jira story JSON file')
  .option('--jira-text <text>',     'Inline Jira acceptance criteria text')
  // ── Path C: Update matrix ─────────────────────────────────────────────────
  .option('--update-matrix',        'Update an existing test matrix')
  .option('--matrix <file>',        'Path to existing test-matrix.json to update')
  .option('--add-cases <file>',     'JSON file with new test cases to merge')
  .option('--remove <ids>',         'Comma-separated test IDs to remove')
  .option('--from-failures <file>', 'Generate new cases from an execution-report.json')
  // ── Flow type ─────────────────────────────────────────────────────────────
  .option('--flow-type <type>',     'Flow type: orderFlow | accountManagement | loginFlow | serviceCheck | generic', 'generic')
  // ── Session management ────────────────────────────────────────────────────
  .option('--session <file>',       'Path to session state file (JSON) for loading/saving cookies')
  .option('--share-session',        'Share browser session across all test cases (for sequential auth flows)')
  // ── Execution options ─────────────────────────────────────────────────────
  .option('--workers <n>',          'Parallel execution workers (default: 1)', '1')
  .option('--timeout <ms>',         'Default per-step timeout in milliseconds (default: 10000)', '10000')
  // ── Output ────────────────────────────────────────────────────────────────
  .option('--out <dir>',            'Custom output directory for this run')
  .option('--no-replay',            'Skip replay verification after recording')
  .option('--no-heal',              'Skip AI healing of low-confidence steps')
  .action(async (options) => {
    log.banner();

    if (!process.env.OPENAI_API_KEY) {
      log.error('OPENAI_API_KEY is not set. Copy .env.example to .env and set your key.');
      process.exit(1);
    }
    log.info(`AI Provider  : ${chalk.bold(describeProvider())}`);

    let detectedPath = 'A';
    if (options.jira || options.jiraText) detectedPath = 'B';
    if (options.updateMatrix)             detectedPath = 'C';

    const runId   = `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const workBase = options.out || process.env.WORK_DIR || './work';
    const runDir   = path.resolve(workBase, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'videos'), { recursive: true });

    log.info(`Run ID     : ${chalk.bold(runId)}`);
    log.info(`Path       : ${chalk.bold(detectedPath === 'A' ? 'A (full pipeline)' : detectedPath === 'B' ? 'B (Jira story)' : 'C (matrix update)')}`);
    log.info(`Flow type  : ${chalk.bold(options.flowType || 'generic')}`);
    log.info(`Work dir   : ${chalk.bold(runDir)}`);
    if (options.url)      log.info(`Target URL : ${chalk.bold(options.url)}`);
    if (options.session)  log.info(`Session    : ${chalk.bold(options.session)}`);
    if (options.shareSession) log.info(`Session    : ${chalk.yellow('shared (sequential mode)')}`);
    console.log('');

    const orchestrator = new Orchestrator({
      runId, runDir,
      path: detectedPath,
      options,
      log
    });

    try {
      await orchestrator.run();
    } catch (err) {
      log.error(err.message);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    }
  });

program.parse(process.argv);
