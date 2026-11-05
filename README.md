# Scrummaster Assistant

A small local chat app for Scrum Masters. Ask for things in plain language ("show me ticket UHF-1234",
"list the refinement tickets") and an OpenAI model hosted in Azure Foundry answers, using Jira,
Confluence and Tempo through the (unofficial) Atlassian MCP
[annadruid/jira-to-confluence](https://github.com/annadruid/jira-to-confluence).

It is meant as a **template**: a simple, working starting point that you extend yourself with Claude Code.

## Features

- Chat interface with Markdown answers; tool calls are shown inline (click to see the raw output)
- **Model selector** filled from the Azure deployments (looked up with just the API key; premade list as fallback)
- **Reasoning level selector** (Default / Minimal / Low / Medium / High; ignored automatically by models that don't support it)
- **Quick-task buttons** with predefined prompts
- **Ticket field** with a "Retrieve" example button
- Read-only by default: the model can only use MCP tools that read data

## Easiest way to get started: let Claude set it up

1. Install [Claude Code](https://claude.com/claude-code) and [Node.js](https://nodejs.org) 22 or newer.
2. Get this project and open a terminal in its folder:
   ```bash
   git clone <this repository's URL> scrummaster-tool
   cd scrummaster-tool
   claude
   ```
3. Type **`how do i start`**.

Claude reads the project's `CLAUDE.md`, checks what is missing (dependencies, the MCP, API keys) and walks you
through each step, then starts the app at http://localhost:3000. You'll need two things from other people/places:
the Azure API key (ask the project owner privately) and your own Atlassian API token (see below).

The same `CLAUDE.md` also teaches Claude how the app works, so afterwards you can simply ask it for features:
"add a button that lists tickets in the current sprint", "answer in Finnish by default", and so on.

## Manual setup

```bash
npm install
git clone https://github.com/annadruid/jira-to-confluence mcp/jira-to-confluence
(cd mcp/jira-to-confluence && npm install)
cp .env.example .env            # then fill in AOAI_BASE_URL and AZURE_API_KEY (ask the project owner)
```

Create `mcp/jira-to-confluence/.env` with at least:

```
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_TOKEN=<Atlassian API token>
JIRA_DOMAIN=https://yourcompany.atlassian.net
CONFLUENCE_DOMAIN=https://yourcompany.atlassian.net/wiki
```

Create the Atlassian token under your Atlassian account → Security → API tokens. Some tools need more
(`TEMPO_API_TOKEN`, `BOARD_ID`, `DEVELOPERS`, …); see that project's README.

Then:

```bash
npm start        # http://localhost:3000
```

If the header shows "MCP offline", run `cd mcp/jira-to-confluence && node server.mjs` to see the real error
(usually a missing variable).

## Configuration (`.env` in this folder)

| Variable | Needed | Meaning |
|---|---|---|
| `AOAI_BASE_URL` | yes | Azure OpenAI v1 URL ending in `/openai/v1/` |
| `AZURE_API_KEY` | yes | Resource key for that Azure account |
| `DEFAULT_MODEL` | no | Deployment preselected in the dropdown (default `gpt-5-mini`) |
| `AZURE_MODELS` | no | Fixed comma-separated model list instead of the live lookup |
| `JIRA_MCP_DIR` | no | Where the MCP lives (default `./mcp/jira-to-confluence`) |
| `ALLOW_WRITE_TOOLS` | no | `true` lets the model create/update things (Jira issues, Confluence pages, notes). Default `false` |
| `PORT` | no | Default 3000 |

## Customising

| Want to… | Edit |
|---|---|
| Add/change example buttons | `PRESETS` at the top of the `<script>` in `public/index.html` |
| Change what "Retrieve" asks | `ticketPrompt` in `public/index.html` |
| Change the assistant's behaviour/language | `SYSTEM_PROMPT` in `server.mjs` |
| Fixed model list / fallback list | `AZURE_MODELS` in `.env`, or `FALLBACK_MODELS` in `server.mjs` |

## How it works

```
browser (public/index.html) ──▶ server.mjs ──▶ Azure Foundry (chat/completions)
                                    └─stdio─▶ Atlassian MCP ──▶ Jira / Confluence / Tempo
```

The server asks the model, runs whatever MCP tools it requests, feeds the results back, and repeats until the
model has an answer. Keys stay on the server. See `CLAUDE.md` for details.

## Security notes

- The app listens on `127.0.0.1` only and has **no login**. Don't expose it on a network.
- Secrets live only in the git-ignored `.env` files. Never commit them or paste them into a chat.
- Only OpenAI-family chat deployments are listed; Claude deployments on the same Azure resource aren't served by the OpenAI v1 endpoint.
- The MCP is a third-party, unofficial project; it uses your personal Atlassian token. Read-only tools are the default for that reason.
- Chat history exists only in the browser tab.
