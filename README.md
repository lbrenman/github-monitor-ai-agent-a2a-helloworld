# github-monitor

> Autonomous GitHub activity agent (A2A Client). Polls a configured list of GitHub repos for new branches and commits, uses Claude to summarize them, and delegates Slack notifications to `slack-notifier-agent` via the A2A protocol.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/lbrenman/github-monitor-ai-agent-a2a-helloworld)

## How It Works

```
github-monitor  ──── A2A ────▶  slack-notifier-agent  ────▶  Slack
  (this repo)                      (separate repo)
```

1. On startup, discovers `slack-notifier-agent` by fetching its Agent Card at `/.well-known/agent-card.json` (falls back to the legacy `/.well-known/agent.json` alias)
2. Every 60 seconds, polls each repo in `GITHUB_REPOS` for branch changes (`GET /repos/{owner}/{repo}/branches`) and new commits (`GET /repos/{owner}/{repo}/commits?since=...`)
3. New events are summarized by Claude
4. The summary is sent to `slack-notifier-agent` as an A2A `message/send` JSON-RPC 2.0 call via `POST /a2a`, with an `x-api-key` header if `NOTIFIER_API_KEY` is set
5. The notifier agent handles crafting and posting the Slack message

> **Why not the GitHub Events API?** An earlier version polled `/users/{user}/events`, but that endpoint is documented by GitHub as not built for real-time use (latency can be anywhere from 30 seconds to 6 hours) and was observed returning empty results even for confirmed, recent activity. Polling branches/commits directly per repo is slower to set up (you have to name the repos) but far more reliable.

## Quick Start

### Step 1 — Start slack-notifier-agent first
Open the [slack-notifier-agent](https://github.com/lbrenman/slack-notifier-agent-ai-agent-a2a-helloworld) repo in a separate Codespace and start it running. Then copy its public port 3100 URL from the Ports tab.

### Step 2 — Start this agent
```bash
git clone https://github.com/lbrenman/github-monitor-ai-agent-a2a-helloworld
cd github-monitor
npm install
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_REPOS, and NOTIFIER_URL
npm start
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `GITHUB_TOKEN` | ✅ | GitHub Personal Access Token (scopes: `repo`, `read:user`) |
| `GITHUB_REPOS` | ✅ | Comma-separated list of repos to monitor. Each entry is `repo-name` (owner assumed to be `GITHUB_USER`) or `owner/repo-name`. Example: `fhir-codespace,Sonos-Vibe-Coded-Loopstation` |
| `NOTIFIER_URL` | ✅ | Public Codespace URL of slack-notifier-agent (port 3100) |
| `NOTIFIER_API_KEY` | — | Must match slack-notifier-agent's `API_KEY` if it has one set. Sent as an `x-api-key` header |
| `GITHUB_USER` | — | Default owner for `GITHUB_REPOS` entries that don't include a slash (default: `lbrenman`) |
| `POLL_INTERVAL_MS` | — | Poll interval in ms (default: `60000`) |
| `MODEL` | — | Claude model (default: `claude-opus-4-5-20251101`) |

## Getting the NOTIFIER_URL

1. Open the `slack-notifier-agent-ai-agent-a2a-helloworld` Codespace 
2. Click the **Ports** tab in VS Code
3. Find port `3100`
4. Set visibility to **Public**
5. Copy the forwarded URL — it looks like:
   `https://leor-laughing-spoon-abc123-3100.app.github.dev`
6. Paste it as `NOTIFIER_URL` in this repo's `.env`
7. If the notifier has `API_KEY` set (auth enabled), also set `NOTIFIER_API_KEY` in this repo's `.env` to the same value

## Demo Script

To generate GitHub activity quickly during a demo:
1. Make sure the repo you're about to change is listed in `GITHUB_REPOS`
2. Create a branch, or commit and push a change, in that repo
3. Within 60 seconds (plus one extra poll if it's a repo the agent hasn't seen before — the first poll for any repo just sets a baseline), github-monitor detects it, Claude summarizes it, and a Slack message appears
