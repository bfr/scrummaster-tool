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
    `tool_call`, `tool_result`, `notice`, `message`, `error`).
  - Listens on 127.0.0.1 only and rejects foreign Host/Origin headers. There is no login — keep it local.
- `public/index.html` — the whole UI (CSS + JS inline). Chat history lives in the browser tab only.
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
- **Errors/retries:** 429/5xx/network failures are retried 3× with backoff; other Azure errors surface in the UI as `Azure <status>: <message>`.
  Diagnose 401/403 → key; 404 → deployment name/endpoint; 400 → model capabilities; 429 → quota.
- Never log keys or full prompts.

## How to add features (recipes)
- **New example button:** add an object to `PRESETS` at the top of the `<script>` in `public/index.html`
  (`label`, `hint`, `prompt`). The prompt is just a message sent to the assistant.
- **Change the "Retrieve ticket" behaviour:** edit `ticketPrompt` in `public/index.html`. It currently asks the model to fetch the
  ticket (the MCP's `get_jira_issue` tool) and summarize it.
- **Change tone/rules/language of answers:** edit `SYSTEM_PROMPT` in `server.mjs`.
- **A new input in the sidebar (e.g. sprint ID, date range):** add the HTML in `<aside>`, a small JS handler that builds a prompt string and calls `send(prompt)`. The model figures out which tool to call from the MCP tool descriptions.
- **Use a new/different MCP tool:** nothing to wire — tools are discovered automatically. Check `GET /api/tools` or the "Tools available" list in the sidebar. If it writes data, it needs `ALLOW_WRITE_TOOLS=true`.
- **Add another MCP server (e.g. official Atlassian one):** `connectMcp()` currently manages one client. Generalise it to a list of clients, prefix tool names with the server name to avoid clashes, and route `callTool` by prefix.
- **Add a non-MCP tool of our own:** push a function definition into the tools array in `chat()` and handle its name in the tool-call loop next to `mcp.callTool`.
- **Something the model does badly (e.g. needs a fixed report format):** prefer adding instructions to `SYSTEM_PROMPT` or to the preset prompt before writing code.
- **Streaming token-by-token, saved conversations, file uploads:** not implemented; possible but would add complexity — confirm with the user first.

## Conventions
- Keep it plain: Node ≥ 22 ES modules, built-ins + `@modelcontextprotocol/sdk` + `dotenv` only. Avoid new dependencies unless they clearly pay off.
- Keep secrets out of code, logs, UI and git. Don't read or print `.env` files in full.
- Don't expose the server beyond localhost or add write tools without telling the user.
- After backend changes, restart the server and test with a real request, e.g.
  `curl -s -N localhost:3000/api/chat -H 'Content-Type: application/json' -d '{"model":"gpt-5-mini","effort":"low","history":[{"role":"user","content":"Say hi"}]}'`.
  Say honestly what was and wasn't verified (e.g. the Jira tools can't be tested without Atlassian credentials).
- Keep `README.md` in sync when setup or customisation steps change.
