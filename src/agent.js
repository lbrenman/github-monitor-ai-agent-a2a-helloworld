/**
 * github-monitor — Autonomous GitHub activity agent (A2A Client)
 *
 * Polls a configured list of GitHub repos (branches + commits) every 60
 * seconds, uses Claude to summarize new activity, then delegates
 * notification to slack-notifier-agent via A2A.
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
// Comma-separated list of repos to monitor. Each entry can be "repo-name"
// (owner assumed to be GITHUB_USER) or "owner/repo-name" for repos you don't own.
// Example: GITHUB_REPOS=fhir-codespace,Sonos-Vibe-Coded-Loopstation,someorg/some-repo
const GITHUB_REPOS  = (process.env.GITHUB_REPOS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(entry => entry.includes('/') ? entry : `${GITHUB_USER}/${entry}`);
const NOTIFIER_URL  = process.env.NOTIFIER_URL;
const NOTIFIER_API_KEY = process.env.NOTIFIER_API_KEY || null; // only needed if notifier has API_KEY set
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const MODEL         = process.env.MODEL || 'claude-opus-4-5-20251101';
const CONTROL_PORT  = parseInt(process.env.CONTROL_PORT || '3000', 10);

if (!GITHUB_TOKEN) { console.error('[error] GITHUB_TOKEN is required'); process.exit(1); }
if (!NOTIFIER_URL) { console.error('[error] NOTIFIER_URL is required'); process.exit(1); }
if (GITHUB_REPOS.length === 0) { console.error('[error] GITHUB_REPOS is required (comma-separated list, e.g. "repo-one,repo-two")'); process.exit(1); }

// ─── State ────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();
// Per-repo state, keyed by "owner/repo": { branches: Set<string>, lastCommitCheck: ISOString, initialized: bool }
const repoState       = new Map();
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
  // Try the A2A v0.3.0 primary path first, fall back to the legacy alias.
  for (const path of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
    const url = `${NOTIFIER_URL}${path}`;
    addLog(`Discovering agent at ${url}...`);
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      notifierAgentCard = await res.json();
      addLog(`Discovered: "${notifierAgentCard.name}" — ${notifierAgentCard.description}`);
      if (notifierAgentCard.security?.length && !NOTIFIER_API_KEY) {
        addLog('WARNING: notifier requires auth (security scheme present) but NOTIFIER_API_KEY is not set.');
      }
      return;
    } catch (err) {
      addLog(`Discovery attempt at ${path} failed: ${err.message}`);
    }
  }
  throw new Error('Agent discovery failed at both agent-card.json and agent.json');
}

async function sendTask(summary) {
  const requestId = randomUUID();
  const body = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        messageId: randomUUID(),
        kind: 'message',
        parts: [{ kind: 'text', text: summary }],
      },
    },
  };

  addLog(`Sending A2A message/send ${requestId} to ${notifierAgentCard?.name}...`);
  const res = await fetch(`${NOTIFIER_URL}/a2a`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(NOTIFIER_API_KEY ? { 'x-api-key': NOTIFIER_API_KEY } : {}),
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    throw new Error('A2A task rejected: 401 Unauthorized — set NOTIFIER_API_KEY to match the notifier\'s API_KEY');
  }
  if (!res.ok) throw new Error(`A2A task failed: ${res.status} ${res.statusText}`);

  const rpcResponse = await res.json();
  if (rpcResponse.error) throw new Error(`A2A task failed: [${rpcResponse.error.code}] ${rpcResponse.error.message}`);

  const task = rpcResponse.result;
  const reply = task?.artifacts?.[0]?.parts?.find(p => (p.kind || p.type) === 'text')?.text;
  addLog(`Task ${task?.status?.state}. Notifier replied: "${reply?.slice(0, 80)}"`);
}

// ─── GitHub ───────────────────────────────────────────────────────────────────
// The GitHub Events API (/users/{user}/events) proved unreliable in practice —
// GitHub documents it as not built for real-time use (latency 30s–6h) and it
// intermittently returns empty results even for confirmed, recent activity.
// Instead, we poll core, actively-maintained endpoints per repo:
//   GET /repos/{owner}/{repo}/branches   → detect created/deleted branches
//   GET /repos/{owner}/{repo}/commits    → detect new pushes (since last poll)

async function githubFetch(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-monitor-agent',
    },
  });
  if (!res.ok) throw new Error(`GitHub API error on ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchBranches(ownerRepo) {
  const branches = await githubFetch(`/repos/${ownerRepo}/branches?per_page=100`);
  return new Set(branches.map(b => b.name));
}

async function fetchCommitsSince(ownerRepo, sinceISO) {
  try {
    return await githubFetch(`/repos/${ownerRepo}/commits?since=${encodeURIComponent(sinceISO)}&per_page=30`);
  } catch (err) {
    // 409 = empty repo (no commits yet); treat as "no new commits" rather than an error.
    if (err.message.includes('409')) return [];
    throw err;
  }
}

// Polls a single repo, returns an array of normalized "event" objects for
// anything new since the last poll. On the first poll for a repo, it just
// records a baseline and returns no events (same philosophy as before).
async function pollRepo(ownerRepo) {
  const now = new Date().toISOString();
  let state = repoState.get(ownerRepo);

  const branches = await fetchBranches(ownerRepo);

  if (!state) {
    state = { branches, lastCommitCheck: now, initialized: true };
    repoState.set(ownerRepo, state);
    return [];
  }

  const events = [];

  // Branch diffs
  for (const name of branches) {
    if (!state.branches.has(name)) {
      events.push({ type: 'CreateEvent', repo: ownerRepo, created_at: now, payload: { ref_type: 'branch', ref: name } });
    }
  }
  for (const name of state.branches) {
    if (!branches.has(name)) {
      events.push({ type: 'DeleteEvent', repo: ownerRepo, created_at: now, payload: { ref_type: 'branch', ref: name } });
    }
  }

  // New commits since last check
  const commits = await fetchCommitsSince(ownerRepo, state.lastCommitCheck);
  if (commits.length > 0) {
    events.push({
      type: 'PushEvent',
      repo: ownerRepo,
      created_at: now,
      payload: {
        commits: commits.slice(0, 5).map(c => c.commit?.message?.split('\n')[0]),
        authors: [...new Set(commits.map(c => c.commit?.author?.name).filter(Boolean))],
      },
    });
  }

  state.branches = branches;
  state.lastCommitCheck = now;

  return events;
}

async function pollAllRepos() {
  const allEvents = [];
  for (const ownerRepo of GITHUB_REPOS) {
    try {
      const events = await pollRepo(ownerRepo);
      allEvents.push(...events);
    } catch (err) {
      addLog(`Error polling ${ownerRepo}: ${err.message}`);
    }
  }
  return allEvents;
}

function summarizePayload(event) {
  const p = event.payload || {};
  switch (event.type) {
    case 'PushEvent':
      return { commits: p.commits, authors: p.authors };
    case 'CreateEvent':
      return { ref_type: p.ref_type, ref: p.ref };
    case 'DeleteEvent':
      return { ref_type: p.ref_type, ref: p.ref };
    default:
      return {};
  }
}

// ─── Claude ───────────────────────────────────────────────────────────────────

async function summarizeEvents(events) {
  const eventData = events.map(e => ({
    type: e.type,
    repo: e.repo,
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
      content: `Summarize these ${events.length} new GitHub event(s):\n\n${JSON.stringify(eventData, null, 2)}`,
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

  addLog(`Polling ${GITHUB_REPOS.length} repo(s)...`);

  try {
    const newEvents = await pollAllRepos();

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
      <span class="pill">repos: ${GITHUB_REPOS.length}</span>
      <span class="pill">interval: ${POLL_INTERVAL / 1000}s</span>
      <span class="pill">polls: ${pollCount}</span>
    </div>
    <div class="meta">
      Last poll: <span>${lastPollTime || '—'}</span><br>
      Last event: <span>${lastEventTime || '—'}</span><br>
      Monitoring: <span>${GITHUB_REPOS.join(', ')}</span><br>
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
    if (method === 'GET'  && url === '/status')  return send(res, 200, { enabled, pollCount, lastPollTime, lastEventTime, lastEventSummary, repos: GITHUB_REPOS, notifier: notifierAgentCard?.name || null });
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
  console.log(`Repos         : ${GITHUB_REPOS.join(', ')}`);
  console.log(`Poll interval : ${POLL_INTERVAL / 1000}s`);
  console.log(`Notifier URL  : ${NOTIFIER_URL}`);
  console.log(`Notifier auth : ${NOTIFIER_API_KEY ? 'x-api-key configured' : 'none'}`);
  console.log(`Web UI        : http://localhost:${CONTROL_PORT}`);
  console.log(`Model         : ${MODEL}`);
  console.log('\nFirst poll sets baseline — notifications start on second poll.\n');

  startControlServer();
  await poll();
  setInterval(poll, POLL_INTERVAL);
}

main();
