# github-monitor

> Autonomous GitHub activity agent (A2A Client). Polls your GitHub account for new events, uses Claude to summarize them, and delegates Slack notifications to `slack-notifier-agent` via the A2A protocol.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/lbrenman/github-monitor-ai-agent-a2a-helloworld)

## How It Works

```
github-monitor  ──── A2A ────▶  slack-notifier-agent  ────▶  Slack
  (this repo)                      (separate repo)
```

1. On startup, discovers `slack-notifier-agent` by fetching its Agent Card at `/.well-known/agent.json`
2. Every 60 seconds, polls the GitHub Events API for your account
3. New events are summarized by Claude
4. The summary is sent to `slack-notifier-agent` as an A2A task via `POST /tasks`
5. The notifier agent handles crafting and posting the Slack message

## Quick Start

### Step 1 — Start slack-notifier-agent first
Open the [slack-notifier-agent](https://github.com/lbrenman/slack-notifier-agent) repo in a separate Codespace and start it running. Then copy its public port 3100 URL from the Ports tab.

### Step 2 — Start this agent
```bash
git clone https://github.com/lbrenman/github-monitor
cd github-monitor
npm install
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY, GITHUB_TOKEN, and NOTIFIER_URL
npm start
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `GITHUB_TOKEN` | ✅ | GitHub Personal Access Token (scopes: `read:user`, `public_repo`) |
| `NOTIFIER_URL` | ✅ | Public Codespace URL of slack-notifier-agent (port 3100) |
| `GITHUB_USER` | — | GitHub username to monitor (default: `lbrenman`) |
| `POLL_INTERVAL_MS` | — | Poll interval in ms (default: `60000`) |
| `MODEL` | — | Claude model (default: `claude-opus-4-5-20251101`) |

## Getting the NOTIFIER_URL

1. Open the `slack-notifier-agent` Codespace
2. Click the **Ports** tab in VS Code
3. Find port `3100`
4. Set visibility to **Public**
5. Copy the forwarded URL — it looks like:
   `https://leor-laughing-spoon-abc123-3100.app.github.dev`
6. Paste it as `NOTIFIER_URL` in this repo's `.env`

## Demo Script

To generate GitHub activity quickly during a demo:
1. Create or edit any file in any of your repos and push it
2. Within 60 seconds, github-monitor detects it, Claude summarizes it, and a Slack message appears
