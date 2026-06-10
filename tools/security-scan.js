'use strict';

/**
 * Security & Vulnerability Scanner for QA Multi-Agent artifacts.
 *
 * Checks for:
 *  1. Exposed API keys / tokens in artifacts
 *  2. Non-redacted passwords in test data
 *  3. PII patterns (email, SSN, credit card numbers)
 *  4. Dangerous selector patterns (code injection risk)
 *  5. Unsafe URL schemes
 *  6. XSS payloads in stored test values
 *  7. SQL injection strings stored unguarded
 */

const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');

// ── Pattern registry ───────────────────────────────────────────────────────
const PATTERNS = [
  {
    id:       'SEC-001',
    severity: 'CRITICAL',
    name:     'Exposed OpenAI / API key',
    re:       /sk-[a-zA-Z0-9]{20,}/g,
    message:  'An OpenAI API key is present in the artifact. Remove immediately.'
  },
  {
    id:       'SEC-002',
    severity: 'CRITICAL',
    name:     'Exposed generic Bearer token',
    re:       /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/g,
    message:  'A Bearer token is stored in the artifact.'
  },
  {
    id:       'SEC-003',
    severity: 'HIGH',
    name:     'Non-redacted password value',
    // Matches password fields whose value is not a ***REDACTED*** placeholder
    re:       /"(?:password|passwd|pwd)":\s*"(?!\*{3}REDACTED)[^"]{3,}"/gi,
    message:  'A password field is stored in plaintext. All passwords must be "***REDACTED***".'
  },
  {
    id:       'SEC-004',
    severity: 'HIGH',
    name:     'Credit card number',
    re:       /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    // Well-known public test card numbers (Stripe, PayPal sandbox, etc.) are expected in test data
    filter:   m => !['4111111111111111','4000000000000002','4000000000000077','5555555555554444',
                     '5105105105105100','378282246310005','371449635398431','6011111111111117'].includes(m.replace(/\s/g,'')),
    message:  'A real credit card number may be present. Use only well-known public test card numbers.'
  },
  {
    id:       'SEC-005',
    severity: 'MEDIUM',
    name:     'Email address in test data',
    re:       /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    // Exclude obvious synthetic test domains and common test email patterns
    filter:   m => !/@(example|test|sample|mailinator|yopmail|guerrillamail|trashmail)\./i.test(m)
                && !/(test|fake|dummy|sample|noreply)@/i.test(m),
    message:  'A real-looking email address is stored in test data. Use synthetic test emails (e.g. test@example.com).'
  },
  {
    id:       'SEC-006',
    severity: 'MEDIUM',
    name:     'SSN pattern',
    re:       /\b\d{3}-\d{2}-\d{4}\b/g,
    message:  'A potential Social Security Number was found.'
  },
  {
    id:       'SEC-007',
    severity: 'LOW',
    name:     'Unsafe URL scheme in selector or value',
    re:       /"(?:javascript:|file:\/\/|data:text\/html)[^"]*"/gi,
    message:  'An unsafe URL scheme (javascript:, file://, data:) was found. This could be an injection vector.'
  },
  {
    id:       'SEC-008',
    severity: 'LOW',
    name:     'Stored XSS payload',
    re:       /<script[^>]*>|javascript:void|onerror\s*=/gi,
    message:  'An XSS payload was found stored in the artifact. Ensure output is always HTML-escaped.'
  },
  {
    id:       'SEC-009',
    severity: 'INFO',
    name:     'SQL injection string stored',
    re:       /(?:' OR 1=1|UNION SELECT|DROP TABLE|--|\/\*.*\*\/)/gi,
    message:  'A SQL injection test string is stored in the artifact (expected in negative test cases — verify it is intentional test data).'
  }
];

const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const SEVERITY_COLOR = {
  CRITICAL: chalk.bgRed.white.bold,
  HIGH:     chalk.red.bold,
  MEDIUM:   chalk.yellow.bold,
  LOW:      chalk.cyan,
  INFO:     chalk.gray
};

// ── File scanner ───────────────────────────────────────────────────────────
function scanText(text, filename) {
  const findings = [];
  for (const pat of PATTERNS) {
    const matches = [...text.matchAll(pat.re)];
    for (const m of matches) {
      if (pat.filter && !pat.filter(m[0])) continue;
      findings.push({
        id:       pat.id,
        severity: pat.severity,
        name:     pat.name,
        message:  pat.message,
        file:     filename,
        snippet:  m[0].slice(0, 60)
      });
    }
  }
  return findings;
}

// ── Structural checks ──────────────────────────────────────────────────────
function structuralChecks(artifact, filename) {
  const findings = [];

  // Check URLs in capture package
  if (artifact.targetUrl) {
    try {
      const u = new URL(artifact.targetUrl);
      if (!['http:', 'https:'].includes(u.protocol)) {
        findings.push({ id: 'SEC-010', severity: 'HIGH', name: 'Unsafe target URL protocol',
          message: `Target URL uses unsafe protocol: ${u.protocol}`, file: filename, snippet: artifact.targetUrl });
      }
    } catch (_) {
      findings.push({ id: 'SEC-011', severity: 'MEDIUM', name: 'Invalid target URL',
        message: `targetUrl is not a valid URL: ${String(artifact.targetUrl).slice(0, 60)}`, file: filename, snippet: String(artifact.targetUrl).slice(0, 60) });
    }
  }

  // Check test steps for unsafe actions
  if (Array.isArray(artifact.testCases)) {
    for (const tc of artifact.testCases) {
      for (const step of (tc.steps || [])) {
        if (step.selector && /`|\$\{|<script/i.test(step.selector)) {
          findings.push({ id: 'SEC-012', severity: 'HIGH', name: 'Potentially unsafe selector',
            message: `Test case ${tc.id} step selector may contain injection characters.`,
            file: filename, snippet: step.selector.slice(0, 80) });
        }
      }
    }
  }

  return findings;
}

// ── Main scanner ───────────────────────────────────────────────────────────
function scanDir(workDir) {
  const allFindings = [];

  if (!fs.existsSync(workDir)) {
    console.log(chalk.yellow(`No directory found at ${workDir}. Nothing to scan.`));
    return;
  }

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fullPath); continue; }
      if (!entry.name.endsWith('.json')) continue;

      try {
        const text     = fs.readFileSync(fullPath, 'utf8');
        const findings = scanText(text, fullPath);

        // Structural checks on parsed JSON
        try {
          const parsed = JSON.parse(text);
          findings.push(...structuralChecks(parsed, fullPath));
        } catch (_) {}

        allFindings.push(...findings);
      } catch (_) {}
    }
  }

  walk(workDir);
  return allFindings;
}

function printReport(findings, workDir) {
  console.log('');
  console.log(chalk.bold.blue('  ╔═══════════════════════════════════════╗'));
  console.log(chalk.bold.blue('  ║     Security & Vulnerability Scan     ║'));
  console.log(chalk.bold.blue('  ╚═══════════════════════════════════════╝'));
  console.log(`  Scanned: ${workDir}`);
  console.log('');

  if (!findings || findings.length === 0) {
    console.log(chalk.green('  ✔ No security issues found.'));
    console.log('');
    return 0;
  }

  // Sort by severity
  const sorted = findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  let critical = 0, high = 0, medium = 0, low = 0, info = 0;
  for (const f of sorted) {
    const col = SEVERITY_COLOR[f.severity] || chalk.gray;
    console.log(`  ${col(`[${f.severity}]`)} ${chalk.bold(f.id)} ${f.name}`);
    console.log(`         ${chalk.gray('File:')} ${f.file}`);
    console.log(`         ${chalk.gray('Msg :')} ${f.message}`);
    if (f.snippet) console.log(`         ${chalk.gray('Snip:')} ${f.snippet}`);
    console.log('');
    if (f.severity === 'CRITICAL') critical++;
    else if (f.severity === 'HIGH') high++;
    else if (f.severity === 'MEDIUM') medium++;
    else if (f.severity === 'LOW') low++;
    else info++;
  }

  console.log('  ─────────────────────────────────────');
  console.log(`  Summary: ${chalk.red.bold(critical + ' CRITICAL')}  ${chalk.red(high + ' HIGH')}  ${chalk.yellow(medium + ' MEDIUM')}  ${chalk.cyan(low + ' LOW')}  ${chalk.gray(info + ' INFO')}`);
  console.log('');

  return critical + high;
}

// ── Entry point ────────────────────────────────────────────────────────────
if (require.main === module) {
  const targetDir = process.argv[2] || path.resolve(__dirname, '../work');
  const findings  = scanDir(targetDir) || [];
  const exitCode  = printReport(findings, targetDir);

  // Write JSON findings for CI consumption
  const outFile = path.resolve(__dirname, '../work/security-scan-result.json');
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ scannedAt: new Date().toISOString(), findings }, null, 2));
    console.log(`  Results written to: ${outFile}`);
  } catch (_) {}

  process.exit(exitCode > 0 ? 1 : 0);
}

module.exports = { scanDir, scanText, printReport };
