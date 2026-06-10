'use strict';

const fs   = require('fs');
const path = require('path');

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusBadge(status) {
  const map = { pass: '#22c55e', fail: '#ef4444', skip: '#a3a3a3' };
  const col = map[status] || '#a3a3a3';
  return `<span style="background:${col};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;">${esc(status.toUpperCase())}</span>`;
}

function screenshotTag(ssPath, label) {
  if (!ssPath || !fs.existsSync(ssPath)) return '';
  try {
    const data = fs.readFileSync(ssPath).toString('base64');
    return `<div style="margin:8px 0;"><div style="font-size:11px;color:#6b7280;margin-bottom:4px;">${esc(label || path.basename(ssPath))}</div>
      <img src="data:image/png;base64,${data}" style="max-width:100%;border:1px solid #e5e7eb;border-radius:4px;" loading="lazy"/></div>`;
  } catch (_) { return ''; }
}

function generate(report, runDir) {
  const { summary, results, aiSummary, targetUrl, flowType, startedAt, completedAt, runId } = report;
  const durationSec = ((new Date(completedAt) - new Date(startedAt)) / 1000).toFixed(1);
  const passRate    = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(0) : 0;

  const testRows = results.map((r, idx) => {
    const steps = (r.steps || []).map(s =>
      `<tr style="border-bottom:1px solid #f3f4f6;">
        <td style="padding:4px 8px;font-size:12px;color:${s.status === 'fail' ? '#ef4444' : '#374151'};">${esc(s.action)}</td>
        <td style="padding:4px 8px;font-size:11px;font-family:monospace;color:#6b7280;">${esc(s.selector || '')}</td>
        <td style="padding:4px 8px;font-size:12px;">${statusBadge(s.status)}</td>
        <td style="padding:4px 8px;font-size:11px;color:#ef4444;">${esc(s.error || '')}</td>
       </tr>`
    ).join('');

    const assertions = (r.assertions || []).map(a =>
      `<tr style="border-bottom:1px solid #f3f4f6;">
        <td style="padding:4px 8px;font-size:12px;">${esc(a.type)}</td>
        <td style="padding:4px 8px;font-size:11px;font-family:monospace;">${esc(a.expected)}</td>
        <td style="padding:4px 8px;font-size:11px;color:#6b7280;">${esc(a.actual || '')}</td>
        <td style="padding:4px 8px;">${a.passed ? '✅' : '❌'}</td>
       </tr>`
    ).join('');

    const screenshots = (r.screenshots || []).map(ss => screenshotTag(ss, path.basename(ss))).join('');
    const networkRows = (r.networkRequests || []).slice(0, 10).map(n =>
      `<div style="font-size:11px;font-family:monospace;color:#6b7280;padding:2px 0;">[${n.status}] ${esc(n.method)} ${esc(n.url.slice(0, 80))}</div>`
    ).join('');

    const borderCol = r.status === 'pass' ? '#22c55e' : r.status === 'skip' ? '#a3a3a3' : '#ef4444';
    return `
<details style="border-left:4px solid ${borderCol};margin-bottom:10px;background:#fff;border-radius:0 6px 6px 0;padding:0;">
  <summary style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;list-style:none;">
    ${statusBadge(r.status)}
    <span style="font-weight:600;flex:1;">[${esc(r.testCaseId)}] ${esc(r.title)}</span>
    <span style="font-size:12px;color:#6b7280;">${r.type} · ${r.durationMs}ms${r.retryCount > 0 ? ` · ${r.retryCount} retry` : ''}</span>
  </summary>
  <div style="padding:12px 14px;border-top:1px solid #f3f4f6;">
    ${r.error ? `<div style="background:#fef2f2;border:1px solid #fecaca;padding:8px 12px;border-radius:4px;margin-bottom:12px;font-size:13px;color:#b91c1c;">${esc(r.error)}</div>` : ''}
    ${steps ? `<div style="margin-bottom:12px;"><div style="font-weight:600;font-size:13px;margin-bottom:6px;">Steps</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:#f9fafb;"><th style="padding:4px 8px;text-align:left;">Action</th><th style="padding:4px 8px;text-align:left;">Selector</th><th style="padding:4px 8px;text-align:left;">Status</th><th style="padding:4px 8px;text-align:left;">Error</th></tr></thead><tbody>${steps}</tbody></table></div>` : ''}
    ${assertions ? `<div style="margin-bottom:12px;"><div style="font-weight:600;font-size:13px;margin-bottom:6px;">Assertions</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:#f9fafb;"><th style="padding:4px 8px;text-align:left;">Type</th><th style="padding:4px 8px;text-align:left;">Expected</th><th style="padding:4px 8px;text-align:left;">Actual</th><th style="padding:4px 8px;">OK</th></tr></thead><tbody>${assertions}</tbody></table></div>` : ''}
    ${networkRows ? `<div style="margin-bottom:12px;"><div style="font-weight:600;font-size:13px;margin-bottom:4px;">Network Requests</div>${networkRows}</div>` : ''}
    ${screenshots ? `<div><div style="font-weight:600;font-size:13px;margin-bottom:4px;">Screenshots</div>${screenshots}</div>` : ''}
  </div>
</details>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>QA Report — ${esc(runId)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;color:#111827;line-height:1.5}
  details>summary::-webkit-details-marker{display:none}
  @media print{details{display:block}details[open]{display:block}}
</style>
</head>
<body>
<div style="max-width:1100px;margin:0 auto;padding:32px 16px;">

  <!-- Header -->
  <div style="margin-bottom:28px;">
    <div style="font-size:22px;font-weight:700;margin-bottom:4px;">QA Execution Report</div>
    <div style="font-size:13px;color:#6b7280;">Run: <code>${esc(runId)}</code> · ${esc(flowType || 'generic')} · ${esc(startedAt)}</div>
    <div style="font-size:13px;color:#6b7280;margin-top:2px;">Target: <a href="${esc(targetUrl)}" target="_blank" style="color:#3b82f6;">${esc(targetUrl)}</a></div>
  </div>

  <!-- Summary cards -->
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:28px;">
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:32px;font-weight:700;color:#111827;">${summary.total}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">Total</div>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:32px;font-weight:700;color:#22c55e;">${summary.passed}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">Passed</div>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:32px;font-weight:700;color:#ef4444;">${summary.failed}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">Failed</div>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:32px;font-weight:700;color:#a3a3a3;">${summary.skipped}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">Skipped</div>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:32px;font-weight:700;color:#3b82f6;">${passRate}%</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">Pass Rate</div>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:32px;font-weight:700;color:#8b5cf6;">${durationSec}s</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">Duration</div>
    </div>
  </div>

  <!-- AI Summary -->
  ${aiSummary ? `
  <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:18px;margin-bottom:28px;">
    <div style="font-weight:600;font-size:14px;color:#1e40af;margin-bottom:8px;">AI Analysis</div>
    <div style="font-size:13px;color:#1e3a8a;white-space:pre-line;">${esc(aiSummary)}</div>
  </div>` : ''}

  <!-- Test Cases -->
  <div style="font-weight:600;font-size:16px;margin-bottom:12px;">Test Cases</div>
  ${testRows}

</div>
</body>
</html>`;

  const reportPath = path.join(runDir, 'execution-report.html');
  fs.writeFileSync(reportPath, html, 'utf8');
  return reportPath;
}

module.exports = { generate };
