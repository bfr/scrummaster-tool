# Scrummaster Assistant — guide for Claude

## What this project is
A small local web app for a Scrum Master on the hel.fi team: a chat GUI where the user asks
for things in natural language and an Azure Foundry OpenAI model answers, calling Jira /
Confluence / Tempo tools through an MCP server when needed.

The user is a Scrum Master, not necessarily a developer. They will ask you to add features
("vibe coding"). Explain changes in plain language, keep the code simple, and don't add
frameworks or build steps (no React/bundlers) — it is deliberately plain Node + one HTML file.

## First thing to do in a new session: check readiness, then offer to fix it
Before anything else (and whenever the user says things like "how do i start"), check the setup below
and tell the user, in plain words, what is missing. **For every missing item, offer to do it for them**
("Want me to run `npm install` now?") and run the command once they agree. Do the steps in order, and don't
make the user type commands you can run yourself. Do **not** print secret values (tokens, keys) — only
whether they are set. Check with e.g. `grep -c '^AZURE_API_KEY=.\+' .env`.

1. **Node 22+:** `node -v`. If missing or older, tell the user to install it from https://nodejs.org (you can't do this for them).
2. **App dependencies:** if `node_modules/` is missing, offer to run `npm install`.
3. **The MCP server:** if `mcp/jira-to-confluence/` is missing, offer to run
   `git clone https://github.com/annadruid/jira-to-confluence mcp/jira-to-confluence`, then
   `npm install` inside `mcp/jira-to-confluence` (also needed if its `node_modules/` is missing).
4. **This folder's `.env`:** if missing, offer to run `cp .env.example .env`. Then both
   `AOAI_BASE_URL` and `AZURE_API_KEY` must be set to real values — the example file only contains the placeholder
   `https://<your-resource>.openai.azure.com/openai/v1/` (check it doesn't still contain `<your-resource>`).
   Both come from the project owner (Roni) and must be entered by the user into the file themselves, privately —
   tell them to paste them into `.env` in their editor, don't ask them to type them into the chat.
5. **Atlassian `.env`:** `mcp/jira-to-confluence/.env` must exist with the variables listed under "`mcp/jira-to-confluence/.env`" below.
   Offer to create the file with empty placeholders for the user to fill in; explain where to get the token.
6. **Start and verify:** offer to run `npm start` (in the background) and open http://localhost:3000. The coloured
   dot in the header shows whether the MCP is connected; a banner shows setup problems. Check `curl -s localhost:3000/api/status`
   and report plainly what works and what doesn't.

## Running
- `npm start` → http://localhost:3000 (`npm run dev` restarts on file changes).
- Stop: Ctrl+C, or `pkill -f "node server.mjs"`.
- After editing `.env` or `server.mjs`, restart. Changes to `public/index.html` only need a browser refresh.
- If the user wants to see it, run the server in the background and `open http://localhost:3000`.
- Mac launcher: `bash scripts/make-mac-app.sh` builds `~/Applications/Scrummaster.app` (starts the server if needed, logs to
  `~/Library/Logs/Scrummaster.log`, opens the installed Chrome app window or a Chrome `--app` window). The page is installable
  as a Chrome/Edge app via `public/manifest.webmanifest` + icons; extra files in `public/` are only served if listed in `STATIC_FILES` in `server.mjs`.

## Environment variables

### This folder's `.env` (Azure + app settings; see `.env.example`)
| Variable | Needed | Meaning |
|---|---|---|
| `AOAI_BASE_URL` | yes | Azure OpenAI v1 URL of our Foundry resource, `https://<resource-name>.openai.azure.com/openai/v1/` (must end in `/openai/v1/`). The real value isn't in the repo — ask the project owner (Roni). |
| `AZURE_API_KEY` | yes | Resource key for that Azure resource. Ask the project owner (Roni) privately; **never paste it into the chat**. |
| `DEFAULT_MODEL` | no | Deployment preselected in the dropdown (default `gpt-5-mini`). |
| `AZURE_MODELS` | no | Comma-separated fixed model list; skips the live lookup. |
| `JIRA_MCP_DIR` | no | Path to the MCP folder (default `./mcp/jira-to-confluence`). |
| `ALLOW_WRITE_TOOLS` | no | `true` lets the model use MCP tools that create/update/delete (create Jira issue, update Confluence page, notes). Default `false` = read-only. Turn on only if the user asks, and say so clearly. |
| `DATA_ZONE_MODELS` | no | Comma-separated deployments that are EU data-zone (SKU `DataZoneStandard`). Default list `DATA_ZONE_MODELS` in `server.mjs`. |
| `REQUIRE_DATA_ZONE` | no | `true` hides/refuses models outside that list. Default `false` (shown with a ⚠ warning). |
| `HIDE_MCP_TOOLS` | no | Comma-separated MCP tools the app doesn't offer the model. Default `add_note,complete_note,clear_notes,get_daily_briefing,add_running_note,search_running_notes` (the notes tools, replaced by the app's own to-dos); empty = show all. They stay in the MCP. |
| `PORT` | no | Default 3000. |

### `mcp/jira-to-confluence/.env` (Atlassian/Tempo; read by the MCP itself)
Minimum for ticket lookup: `ATLASSIAN_EMAIL`, `ATLASSIAN_TOKEN`, `JIRA_DOMAIN`
(`https://yourcompany.atlassian.net`, no trailing slash), `CONFLUENCE_DOMAIN`
(`https://yourcompany.atlassian.net/wiki`).
Tool-specific extras: `TEMPO_API_TOKEN` (hours/efficiency), `BOARD_ID`, `SPACE_KEY`,
`PARENT_PAGE_ID`, `TEMPLATE_PAGE_ID` (Confluence sprint pages), `SEVERA_SOAP_API`,
`SEVERA_PROJECT_FILTER`, `DEVELOPERS` (`Name,TempoAccountId,FE|BE;...`). Full list: that folder's README.md.
- Atlassian API token: Atlassian account → Security → API tokens. Tempo token: Jira → Tempo → Settings → API Integration.
- Alternatively these variables can go in this folder's `.env`: the app passes its environment to the MCP.
- If the MCP exits at startup (the UI says "Connection closed"), run
  `cd mcp/jira-to-confluence && node server.mjs` to see the real error (usually a missing variable).
- Tokens belong only in `.env` files. `.gitignore` already excludes `.env` and `mcp/`. Never commit them or echo them.

## Architecture
```
browser (public/index.html)  ──HTTP/NDJSON──▶  server.mjs  ──▶ Azure Foundry (chat/completions)
                                                   └──stdio──▶ MCP server (mcp/jira-to-confluence/server.mjs) ──▶ Jira/Confluence/Tempo
```
- `server.mjs` — the whole backend (no framework). Sections: MCP connection, Azure model list, chat loop, HTTP routes.
  - `GET /api/status`, `GET /api/models`, `GET /api/tools`, `POST /api/chat` (streams newline-delimited JSON events:
    `tool_call`, `confirm`, `tool_result`, `todos_changed`, `notice`, `message`, `error`), `POST /api/confirm`,
    `GET /api/todos`, `POST /api/todos/done {id, done}`.
  - Listens on 127.0.0.1 only and rejects foreign Host/Origin headers. There is no login — keep it local.
- `public/index.html` — the whole UI (CSS + JS inline). Chat history lives in the browser tab only.
  Colours are Helsinki Design System tokens (https://hds.hel.fi/foundation/design-tokens/colour/), defined once as CSS variables in `:root`
  with the HDS token name in a comment. Use those variables, not new hex values. HDS has no dark theme; the dark block uses HDS grayscale/brand colours.
- `mcp/jira-to-confluence/` — third-party, **unofficial** MCP ([annadruid/jira-to-confluence](https://github.com/annadruid/jira-to-confluence)),
  git-ignored. Don't edit it for app features; treat it as a dependency. It is Finnish/hel.fi-specific (e.g. `UHF-` project, Finnish tool descriptions).

## How the Foundry integration works
- Uses the Azure OpenAI **v1** API directly with `fetch` (no SDK): `POST {AOAI_BASE_URL}/chat/completions`,
  header `api-key: <key>`, body `model` = the **deployment name** (not necessarily the model family), `messages`, `tools`.
  No `api-version` parameter for this call. Keys stay on the server; the browser never sees them.
- **Model dropdown:** the server calls `GET https://<resource>.openai.azure.com/openai/deployments?api-version=2023-03-15-preview`
  with the same API key (no `az login` needed), keeps succeeded OpenAI-family chat deployments (`gpt*`, `o<digit>*`; excludes embeddings,
  image, audio), caches 5 min. If the lookup fails it falls back to `FALLBACK_MODELS` in `server.mjs` and shows a warning.
  Claude deployments exist on the resource but are **not** served by this endpoint (404), so they are filtered out. Embedding
  deployments use a different endpoint and are not for chat.
- **GDPR / data zone:** the key-only API can't report a deployment's SKU (`DataZoneStandard` = EU processing, `GlobalStandard` = may be
  processed anywhere), so `server.mjs` keeps a list (`DATA_ZONE_MODELS`) taken from
  `az cognitiveservices account deployment list --query '[].{n:name,sku:sku.name}'`. The UI shows an "EU data zone" / "not confirmed EU"
  badge and ⚠ in the dropdown. Models not on the list (new deployments, or Global ones such as gpt-4o, gpt-6.1-sol at the time of writing) are
  flagged until someone with `az` access updates the list. Never claim a model is EU-safe unless it is on the list.
- **Reasoning level:** the dropdown value is sent as `reasoning_effort` (`minimal|low|medium|high`; "Default" omits it). Models that
  don't support it (e.g. gpt-4o) reject it with 400; `callModel` retries without it and the UI shows a notice. Don't send
  `temperature`/`top_p` to reasoning models. Use `max_completion_tokens`, not `max_tokens`.
- **Tool calling loop (`chat()` in `server.mjs`):** MCP tools are converted to OpenAI function tools (`toOpenAiTools`). The model replies
  with `tool_calls` → the server runs each via `mcp.callTool` → results are appended as `role: "tool"` messages → repeat, at most
  `MAX_TOOL_ROUNDS` (8), then a final answer. Tool results are truncated to 30,000 chars.
- **Safety default:** only MCP tools with `readOnlyHint: true` are exposed unless `ALLOW_WRITE_TOOLS=true`.
- **Approvals:** with write tools on, any tool without `readOnlyHint: true` pauses the chat loop: the server emits a `confirm` event
  (`id`, `name`, `description`, `args`), the UI shows an Allow/Cancel card, and the browser answers with `POST /api/confirm {id, allow}`.
  No answer within 10 min, or the browser closing, counts as Cancel; a cancelled call is reported to the model as declined. Keep this.
- **Errors/retries:** 429/5xx/network failures are retried 3× with backoff; other Azure errors surface in the UI as `Azure <status>: <message>`.
  Diagnose 401/403 → key; 404 → deployment name/endpoint; 400 → model capabilities; 429 → quota.
- Never log keys or full prompts.

## How to add features (recipes)
- **App's own tools (`LOCAL_TOOLS` in `server.mjs`):** besides the to-do tools: `get_closed_sprints` (board `BOARD_ID`, latest closed
  sprints), `find_sprint_report_pages` (children of `PARENT_PAGE_ID` whose title has the sprint number) — both read-only, using the
  Atlassian settings from the MCP's `.env` (this folder's `.env` wins) — and `update_quarter_pages` (`write: true`: runs
  `node updateQuarterPages.mjs <source> <target>` in the MCP folder via execFile, only with ALLOW_WRITE_TOOLS and after Allow).
  Also: `get_next_sprint_info` (active + future sprints, next sprint number, Wed–Tue dates and max htp minus Finnish public holidays
  and calendar "lähipäivä" events, plus the ready "ask for htp estimates" Slack message), `get_sprint_capacity` (runs
  `getSprintCapacity.mjs`, feeding its three prompts via stdin; read-only), `preview_release_tickets` (`cloneReleaseTickets --dry-run`),
  `clone_release_tickets` (write), `preview_sprint_tickets` + `clone_sprint_tickets` (write). `cloneSprintTickets.mjs` has no dry run
  or duplicate check, so the app reads its `SOURCE_KEYS`, looks for the resulting titles in the sprint and refuses if any exist.
  MCP scripts run through `runMcpScript()` (spawn, no shell, numeric args only, 15 min timeout).
  A `write: true` local tool goes through the same Allow/Cancel step as MCP write tools. The sprint-day quick tasks
  "Päivitä sprinttiraportti" (closed sprint → confirm → page → confirm → MCP `update_confluence_sprint_page`, same code as `npm run update`)
  and "Päivitä kvartaalisivut" (asks source + target page) are step-by-step prompts in `PRESETS`. Chat history sent to the model holds
  only visible text, so step prompts make the model repeat needed IDs in its questions.
- **Copy buttons:** every assistant reply gets "Kopioi vastaus" and every code block "Kopioi" (`copyButton()` in `public/index.html`,
  with an `execCommand('copy')` fallback). Preset prompts that produce a Slack/Teams message ask for it in a code block.
- **Own to-dos from the chat:** the server has its own (non-MCP) tools `add_todo`, `list_todos`, `complete_todo` (`TODO_TOOLS` in `server.mjs`),
  stored in `todos.json` (git-ignored; `{ id, text, added, doneOn }`). They need no Allow step (they only touch that file). Open items stay every day;
  an item ticked done is shown that day and pruned once the date changes. The Today panel lists them after the weekday routine (dashed border).
- **Today panel / weekday to-dos:** `TODOS` in `public/index.html` (`mon`…`sun`, plus `every` = checked on every weekday, used for meeting-based to-dos such as `BILLING_DAY` ("Hel.fi laskutus"); items are text or `{ text, hint, show }`; `show` uses the same rules as presets, e.g. `SPRINT_CHANGE_TOMORROW`). Ticks live in the
  browser's localStorage under `todos:YYYY-MM-DD` (per day, per browser — fine for a single-user local app). Presets with a `show` rule are
  listed under the day heading; presets without one stay in "Quick tasks". `TODOS` is the user's real routine (mon–fri), with sprint-timing rules `SPRINT_CHANGE_TOMORROW/TODAY/YESTERDAY/CHANGED_THIS_WEEK`.
  `SPRINT_CHANGE` (shared regex) = the meetings held on sprint-change day (sprint planning, demo, Dev+UX planning, Devin retro); keep the user's
  Finnish to-do wording (only fix obvious typos).
- **Quick tasks that follow the calendar/weekday:** each `PRESETS` entry can have `show: [{ days, meeting, workdaysBefore, workdaysAfter }]` (numbers or lists) (any rule
  matching shows it; no `show` = always) and `{meeting} {time} {day} {week} {prevMonth} {prevMonthName}` placeholders (prevMonth = the month before the meeting, `YYYY-MM`; used by the billing-summary task). Meetings come from `GET /api/calendar` =
  `calendar.json` (git-ignored; title/start/end/allDay only), written by `scripts/save-calendar.mjs` from Google Calendar `list_events`
  output. The Claude scheduled task `scrummaster-calendar-refresh` (daily 07:00, past 7 + next 14 days, needs Claude Desktop open) does the fetch with Claude's
  Google Calendar connector; the app itself has no Google access. `?today=YYYY-MM-DD` previews another day.
- **New example button:** add an object to `PRESETS` at the top of the `<script>` in `public/index.html`
  (`label`, `hint`, `prompt`). The prompt is just a message sent to the assistant.
- **Change tone/rules/language of answers:** edit `SYSTEM_PROMPT` in `server.mjs`. Its key rule (the user asked for it): ready-made tool
  output (refinement lists, reports…) is shown exactly as the MCP returns it — no translating, summarising or reformatting unless asked.
- **A new input in the sidebar (e.g. sprint ID, date range):** add the HTML in `<aside>`, a small JS handler that builds a prompt string and calls `send(prompt)`. The model figures out which tool to call from the MCP tool descriptions.
- **Use a new/different MCP tool:** nothing to wire — tools are discovered automatically. Check `GET /api/tools` or the "Tools available" list in the sidebar. If it writes data, it needs `ALLOW_WRITE_TOOLS=true`.
- **Add another MCP server (e.g. official Atlassian one):** `connectMcp()` currently manages one client. Generalise it to a list of clients, prefix tool names with the server name to avoid clashes, and route `callTool` by prefix.
- **Add a non-MCP tool of our own:** push a function definition into the tools array in `chat()` and handle its name in the tool-call loop next to `mcp.callTool`.
- **Something the model does badly (e.g. needs a fixed report format):** prefer adding instructions to `SYSTEM_PROMPT` or to the preset prompt before writing code.
- **Streaming token-by-token, saved conversations, file uploads:** not implemented; possible but would add complexity — confirm with the user first.

## Conventions
- **Language:** the user uses the app in Finnish. Everything visible in the UI (labels, hints, quick-task prompts, messages, to-do
  tool results) is Finnish; code, comments and docs stay English. `SYSTEM_PROMPT` tells the model to answer in Finnish unless the user
  writes in another language. Write new UI text and preset prompts in Finnish.
- Keep it plain: Node ≥ 22 ES modules, built-ins + `@modelcontextprotocol/sdk` + `dotenv` only. Avoid new dependencies unless they clearly pay off.
- Keep secrets out of code, logs, UI and git. Don't read or print `.env` files in full.
- Don't expose the server beyond localhost or add write tools without telling the user.
- After backend changes, restart the server and test with a real request, e.g.
  `curl -s -N localhost:3000/api/chat -H 'Content-Type: application/json' -d '{"model":"gpt-5-mini","effort":"low","history":[{"role":"user","content":"Say hi"}]}'`.
  Say honestly what was and wasn't verified (e.g. the Jira tools can't be tested without Atlassian credentials).
- Keep `README.md` in sync when setup or customisation steps change.
