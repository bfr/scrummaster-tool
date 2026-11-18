# Scrummaster Assistant

A small local chat app for Scrum Masters. Ask for things in plain language ("show me ticket UHF-1234",
"list the refinement tickets") and an OpenAI model hosted in Azure Foundry answers, using Jira,
Confluence and Tempo through the (unofficial) Atlassian MCP
[annadruid/jira-to-confluence](https://github.com/annadruid/jira-to-confluence).

It is meant as a **template**: a simple, working starting point that you extend yourself with Claude Code.

## Features

- Chat interface with Markdown answers; tool calls are shown inline (click to see the raw output)
- **Model selector** filled from the Azure deployments (looked up with just the API key; premade list as fallback)
- **Reasoning level selector**: the app checks which levels the chosen model accepts and greys out the rest (disabled completely for models like gpt-4o)
- **Today panel:** the weekday and date, a to-do list for that weekday (ticks are remembered per day), and the quick tasks for that day
- **Your own to-dos from the chat:** "add a todo: book the retro room" adds it to the Today list. It stays there day after day
  until you tick it (or say "mark … done"); ticked items disappear when the day changes. Saved in `todos.json` (not in git)
- **Finnish interface:** all buttons, quick tasks and replies are in Finnish (the code is in English)
- **Quick-task buttons** that follow the weekday and your calendar (e.g. "Prepare sprint changeover" the working day before the retro)
- **Sprint change day helpers:** "Päivitä sprinttiraportti" finds the sprint that just closed and its Confluence page and asks you
  to confirm both before updating (same as `npm run update`); "Päivitä kvartaalisivut" finds the current quarter's source and target pages under "Tiekartta <year>: seuranta" by the date range in the page title, asks you to confirm them (titles + links), and runs
  `npm run updateQuarterPages`. Both need `ALLOW_WRITE_TOOLS=true` and your Allow click
- **Monday and sprint-change helpers:** hours check Tempo vs. Severa with a ready Slack confirmation; the "ask for htp estimates"
  message with the next sprint's number, dates and max person-days; recurring meeting/release tickets for the new sprint (preview
  first, never duplicates); the capacity estimate for Aleksi (`npm run getSprintCapacity`); the Teams message for sharing the sprint report
- **Copy buttons** on replies and on every code block, for pasting into Slack or Teams
- **Refresh models and regions** button (↻ next to the model) opens a dialog: *refresh from API* (works for everyone) or *refresh from Azure CLI* (greyed out unless `az` is installed and signed in). The az option: with the `az` CLI installed, `az login` done and read access to the Foundry resource, it reads each deployment's real SKU (EU data zone / Global / Regional) and remembers it in the git-ignored `.az-models.json`. Without it the built-in list is used
- **GDPR flag:** each model is marked "EU data zone" or "not confirmed EU" (global deployments may process data outside the EU)
- Read-only by default: the model can only use MCP tools that read data. With write tools on, every change
  (create/update/delete) pauses with an **Allow / Cancel** card showing exactly what will be sent

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

## Run it like a Mac app

Once setup works, you can start it without a terminal:

1. **Build the launcher** (once, and again if you move this folder):
   ```bash
   bash scripts/make-mac-app.sh
   ```
   This creates `~/Applications/Scrummaster.app`. Open it from Spotlight (Cmd+Space → "Scrummaster")
   or drag it to the Dock. Clicking it starts the server in the background if needed and opens the assistant.
   Server output goes to `~/Library/Logs/Scrummaster.log`.
2. **Give it its own window** (optional, Chrome or Edge): in the window that opens, click the install icon
   at the right end of the address bar, or ⋮ → *Cast, save and share* → *Install page as app*. From then on the
   launcher opens that app window, with its own icon in the Dock and in Cmd+Tab.

Closing the window leaves the server running in the background (it uses next to nothing while idle).
To stop it: `pkill -f "node server.mjs"`. It is still only reachable from your own laptop.

## Configuration (`.env` in this folder)

| Variable | Needed | Meaning |
|---|---|---|
| `AOAI_BASE_URL` | yes | Azure OpenAI v1 URL ending in `/openai/v1/` |
| `AZURE_API_KEY` | yes | Resource key for that Azure account |
| `DEFAULT_MODEL` | no | Deployment preselected in the dropdown (default `gpt-5-mini`) |
| `AZURE_MODELS` | no | Fixed comma-separated model list instead of the live lookup |
| `JIRA_MCP_DIR` | no | Where the MCP lives (default `./mcp/jira-to-confluence`) |
| `ALLOW_WRITE_TOOLS` | no | `true` lets the model create/update things (Jira issues, Confluence pages, notes); each one asks you to Allow it first. Default `false` |
| `DATA_ZONE_MODELS` | no | Deployments that run in the EU data zone (default list in `server.mjs`) |
| `REQUIRE_DATA_ZONE` | no | `true` hides and refuses all models not in that list (GDPR). Default `false` = they are shown with a warning |
| `HIDE_MCP_TOOLS` | no | MCP tools left out of the chat. Default: the notes tools (`add_note`, `complete_note`, `clear_notes`, `get_daily_briefing`, `add_running_note`, `search_running_notes`), since to-dos are handled by the app |
| `PORT` | no | Default 3000 |

## Customising

| Want to… | Edit |
|---|---|
| Change the to-do list for each weekday | `TODOS` at the top of the `<script>` in `public/index.html` (items can have a `show` rule, e.g. only before a sprint change; `every` holds to-dos checked on any weekday, such as the billing-day ones) |
| Add/change quick-task buttons, and when they show | `PRESETS` at the top of the `<script>` in `public/index.html` (rules: `days`, `meeting`, `workdaysBefore`, `workdaysAfter`; explained in the comment above it) |
| Change the assistant's behaviour/language | `SYSTEM_PROMPT` in `server.mjs` |
| Fixed model list / fallback list | `AZURE_MODELS` in `.env`, or `FALLBACK_MODELS` in `server.mjs` |

## Calendar-based quick tasks

Some quick tasks only appear on certain weekdays or around certain meetings. The meetings come from `calendar.json`
(git-ignored, only meeting titles and times), which a Claude Desktop scheduled task, **"Scrummaster: päivitä kalenteri"**,
refreshes every morning at 07:00 with the past week and the next two weeks, using Claude's Google Calendar connector:

- The task only runs while Claude Desktop is open; if it was closed at 07:00 it runs when you next open it.
  The sidebar shows when the calendar was last updated and turns orange if it is more than 36 hours old.
- Without `calendar.json` the app still works; only the weekday and always-on tasks are shown.
- To fill it by hand: open the task in Claude Desktop (Scheduled in the sidebar) and click *Run now*.
- To preview another day: open `http://localhost:3000/?today=2026-11-16`.

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
