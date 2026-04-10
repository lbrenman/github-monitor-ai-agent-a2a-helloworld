/**
 * github-monitor — Autonomous GitHub activity agent (A2A Client)
 *
 * Polls the GitHub Events API every 60 seconds, uses Claude to summarize
 * new activity, then delegates notification to slack-notifier-agent via A2A.
 *
 * Control API + Web UI (port 3000):
 *   GET  /          → Web UI with live toggle
 *   GET  /status    → JSON status
 *   POST /enable    → Enable polling
 *   POST /disable   → Disable polling
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { randomUUID } = require('crypto');
const http = require('http');

// ─── Configuration ────────────────────────────────────────────────────────────

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_USER   = process.env.GITHUB_USER || 'lbrenman';
const NOTIFIER_URL  = process.env.NOTIFIER_URL;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const MODEL         = process.env.MODEL || 'claude-opus-4-5-20251101';
const CONTROL_PORT  = parseInt(process.env.CONTROL_PORT || '3000', 10);

if (!GITHUB_TOKEN) { console.error('[error] GITHUB_TOKEN is required'); process.exit(1); }
if (!NOTIFIER_URL) { console.error('[error] NOTIFIER_URL is required'); process.exit(1); }

// ─── State ────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();
let lastSeenEventId   = null;
let notifierAgentCard = null;
let enabled           = true;
let pollCount         = 0;
let lastPollTime      = null;
let lastEventTime     = null;
let lastEventSummary  = null;
let recentLog         = [];

function addLog(msg) {
  const entry = { ts: new Date().toISOString(), msg };
  recentLog.unshift(entry);
  if (recentLog.length > 10) recentLog.pop();
  console.log(`[${entry.ts}] ${msg}`);
}

// ─── A2A ──────────────────────────────────────────────────────────────────────

async function discoverNotifier() {
  const url = `${NOTIFIER_URL}/.well-known/agent.json`;
  addLog(`Discovering agent at ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Agent discovery failed: ${res.status} ${res.statusText}`);
  notifierAgentCard = await res.json();
  addLog(`Discovered: "${notifierAgentCard.name}" — ${notifierAgentCard.description}`);
}

async function sendTask(summary) {
  const task = {
    id: randomUUID(),
    message: { parts: [{ type: 'text', text: summary }] },
  };
  addLog(`Sending A2A task ${task.id} to ${notifierAgentCard?.name}...`);
  const res = await fetch(`${NOTIFIER_URL}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  });
  if (!res.ok) throw new Error(`A2A task failed: ${res.status} ${res.statusText}`);
  const result = await res.json();
  const reply = result.artifacts?.[0]?.parts?.find(p => p.type === 'text')?.text;
  addLog(`Task complete. Notifier replied: "${reply?.slice(0, 80)}"`);
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

async function fetchEvents() {
  const res = await fetch(`https://api.github.com/users/${GITHUB_USER}/events?per_page=30`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-monitor-agent',
    },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  return res.json();
}

function filterNewEvents(events) {
  if (!lastSeenEventId) {
    if (events.length > 0) lastSeenEventId = events[0].id;
    return [];
  }
  const newEvents = events.filter(e => BigInt(e.id) > BigInt(lastSeenEventId));
  if (newEvents.length > 0) lastSeenEventId = newEvents[0].id;
  return newEvents;
}

function summarizePayload(event) {
  const p = event.payload || {};
  switch (event.type) {
    case 'PushEvent':
      return { branch: p.ref?.replace('refs/heads/', ''), commits: p.commits?.map(c => c.message).slice(0, 3) };
    case 'CreateEvent':
      return { ref_type: p.ref_type, ref: p.ref, description: p.description };
    case 'DeleteEvent':
      return { ref_type: p.ref_type, ref: p.ref };
    case 'PullRequestEvent':
      return { action: p.action, title: p.pull_request?.title, number: p.number };
    case 'IssuesEvent':
      return { action: p.action, title: p.issue?.title, number: p.issue?.number };
    case 'IssueCommentEvent':
      return { action: p.action, issue: p.issue?.title, body: p.comment?.body?.slice(0, 100) };
    case 'WatchEvent':   return { action: p.action };
    case 'ForkEvent':    return { forkee: p.forkee?.full_name };
    case 'ReleaseEvent': return { action: p.action, tag: p.release?.tag_name, name: p.release?.name };
    case 'MemberEvent':  return { action: p.action, member: p.member?.login };
    default:             return {};
  }
}

// ─── Claude ───────────────────────────────────────────────────────────────────

async function summarizeEvents(events) {
  const eventData = events.map(e => ({
    type: e.type,
    repo: e.repo?.name,
    actor: e.actor?.login,
    created_at: e.created_at,
    payload: summarizePayload(e),
  }));

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: `You are a GitHub activity monitor. Summarize GitHub events into a clear description 
to hand off to a notification agent. Be specific — include repo names, branch names, commit messages, 
PR titles etc. Keep it under 150 words. Plain text only.`,
    messages: [{
      role: 'user',
      content: `Summarize these ${events.length} new GitHub event(s) for user ${GITHUB_USER}:\n\n${JSON.stringify(eventData, null, 2)}`,
    }],
  });

  return response.content[0].text;
}

// ─── Poll Loop ────────────────────────────────────────────────────────────────

async function poll() {
  lastPollTime = new Date().toISOString();
  pollCount++;

  if (!enabled) {
    addLog('Poll skipped — agent is disabled.');
    return;
  }

  addLog('Polling GitHub...');

  try {
    const events = await fetchEvents();
    const newEvents = filterNewEvents(events);

    if (newEvents.length === 0) {
      addLog('No new events.');
      return;
    }

    addLog(`${newEvents.length} new event(s) found!`);
    const summary = await summarizeEvents(newEvents);
    lastEventSummary = summary;
    lastEventTime = new Date().toISOString();
    addLog(`Claude summary: "${summary.slice(0, 100)}..."`);
    await sendTask(summary);

  } catch (err) {
    addLog(`Error: ${err.message}`);
  }
}

// ─── Web UI ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderUI() {
  const statusColor = enabled ? '#22c55e' : '#ef4444';
  const statusText  = enabled ? 'ENABLED' : 'DISABLED';
  const toggleLabel = enabled ? 'Disable Agent' : 'Enable Agent';
  const toggleClass = enabled ? 'btn-disable' : 'btn-enable';

  const logRows = recentLog.map(e =>
    `<tr><td class="ts">${e.ts}</td><td>${escapeHtml(e.msg)}</td></tr>`
  ).join('') || `<tr><td colspan="2" class="empty">No activity yet.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>github-monitor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 2rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
    .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 2rem; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .card h2 { font-size: 0.9rem; color: #94a3b8; margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .status-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .badge { padding: 0.35rem 1.1rem; border-radius: 999px; font-weight: 700; font-size: 0.9rem; color: #fff; background: ${statusColor}; }
    .meta { color: #94a3b8; font-size: 0.85rem; margin-top: 0.85rem; line-height: 2; }
    .meta span { color: #e2e8f0; font-weight: 500; }
    .btn { padding: 0.6rem 1.4rem; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
    .btn:active { opacity: 0.7; }
    .btn-enable  { background: #22c55e; color: #fff; }
    .btn-disable { background: #ef4444; color: #fff; }
    .btn-group { margin-top: 1.25rem; display: flex; gap: 0.75rem; }
    .pill { display: inline-block; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 0.2rem 0.6rem; font-size: 0.78rem; color: #94a3b8; margin-right: 0.5rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th { text-align: left; padding: 0.5rem 0.75rem; color: #64748b; font-weight: 600; border-bottom: 1px solid #334155; }
    td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #0f172a; vertical-align: top; word-break: break-word; }
    .ts { color: #64748b; white-space: nowrap; width: 210px; }
    .empty { color: #475569; text-align: center; padding: 1.5rem 0; }
    .summary-box { background: #0f172a; border-radius: 8px; padding: 1rem; font-size: 0.85rem; color: #cbd5e1; line-height: 1.7; white-space: pre-wrap; }
  </style>
  <meta http-equiv="refresh" content="10">
</head>
<body>
  <h1>🔍 github-monitor</h1>
  <p class="subtitle">Autonomous GitHub activity agent &nbsp;·&nbsp; A2A Client &nbsp;·&nbsp; Auto-refreshes every 10s</p>

  <div class="card">
    <div class="status-row">
      <div class="badge">${statusText}</div>
      <span class="pill">user: ${GITHUB_USER}</span>
      <span class="pill">interval: ${POLL_INTERVAL / 1000}s</span>
      <span class="pill">polls: ${pollCount}</span>
    </div>
    <div class="meta">
      Last poll: <span>${lastPollTime || '—'}</span><br>
      Last event: <span>${lastEventTime || '—'}</span><br>
      Notifier agent: <span>${notifierAgentCard?.name || 'not connected'}</span>
    </div>
    <div class="btn-group">
      <button class="btn ${toggleClass}" onclick="toggle()">${toggleLabel}</button>
    </div>
  </div>

  ${lastEventSummary ? `
  <div class="card">
    <h2>Last Event Summary Sent to Notifier</h2>
    <div class="summary-box">${escapeHtml(lastEventSummary)}</div>
  </div>` : ''}

  <div class="card">
    <h2>Activity Log</h2>
    <table>
      <thead><tr><th>Timestamp</th><th>Message</th></tr></thead>
      <tbody>${logRows}</tbody>
    </table>
  </div>

  <script>
    async function toggle() {
      const action = ${JSON.stringify(enabled)} ? 'disable' : 'enable';
      await fetch('/' + action, { method: 'POST' });
      location.reload();
    }
  </script>
</body>
</html>`;
}

// ─── Control HTTP Server ──────────────────────────────────────────────────────

function send(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function startControlServer() {
  const server = http.createServer((req, res) => {
    const { method, url } = req;

    if (method === 'GET'  && url === '/')        return send(res, 200, renderUI(), 'text/html');
    if (method === 'GET'  && url === '/status')  return send(res, 200, { enabled, pollCount, lastPollTime, lastEventTime, lastEventSummary, githubUser: GITHUB_USER, notifier: notifierAgentCard?.name || null });
    if (method === 'POST' && url === '/enable')  { enabled = true;  addLog('Agent ENABLED via API.');  return send(res, 200, { enabled }); }
    if (method === 'POST' && url === '/disable') { enabled = false; addLog('Agent DISABLED via API.'); return send(res, 200, { enabled }); }

    send(res, 404, { error: 'Not found' });
  });

  server.listen(CONTROL_PORT, () => {
    addLog(`Control server listening — Web UI at http://localhost:${CONTROL_PORT}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await discoverNotifier();
  } catch (err) {
    console.error(`[error] Could not reach slack-notifier-agent: ${err.message}`);
    console.error('Make sure NOTIFIER_URL is set and the notifier Codespace is running.');
    process.exit(1);
  }

  console.log('╔════════════════════════════════════════════╗');
  console.log('║        github-monitor  v3.0.0              ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`GitHub user   : ${GITHUB_USER}`);
  console.log(`Poll interval : ${POLL_INTERVAL / 1000}s`);
  console.log(`Notifier URL  : ${NOTIFIER_URL}`);
  console.log(`Web UI        : http://localhost:${CONTROL_PORT}`);
  console.log(`Model         : ${MODEL}`);
  console.log('\nFirst poll sets baseline — notifications start on second poll.\n');

  startControlServer();
  await poll();
  setInterval(poll, POLL_INTERVAL);
}

main();
