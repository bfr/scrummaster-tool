// Scrummaster tool backend.
//  - serves public/index.html
//  - GET  /api/models  -> chat deployments from Azure Foundry (+ EU data-zone flag)
//  - GET  /api/reasoning?model=x -> which reasoning levels that deployment accepts (probed)
//  - POST /api/models/refresh -> optional: verify SKU/region with `az` (needs az login + access)
//  - GET  /api/tools   -> tools exposed by the Atlassian MCP
//  - GET  /api/calendar -> calendar.json (next two weeks of meeting titles/times, for quick-task rules)
//  - POST /api/chat    -> runs the model <-> MCP tool-calling loop, streams NDJSON events
//  - POST /api/confirm -> the user's Allow/Cancel answer for a pending write tool
//  - GET  /api/todos, POST /api/todos/done -> the user's own to-dos (todos.json), also editable from the chat
// Keys never leave this process. Binds to localhost only.
import 'dotenv/config';
import { parse as parseEnv } from 'dotenv';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile); // used by the optional `az` checks
const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const PORT = Number(env.PORT || 3000);
const BASE_URL = (env.AOAI_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = env.AZURE_API_KEY || '';
const MCP_DIR = resolve(here, env.JIRA_MCP_DIR || './mcp/jira-to-confluence');
const ALLOW_WRITE = env.ALLOW_WRITE_TOOLS === 'true';
const MAX_TOOL_ROUNDS = 8;
// MCP tools this app doesn't offer the model (they stay in the MCP itself). The daily notes list and running notes are replaced
// by the app's own to-dos (add_todo etc.). Override with HIDE_MCP_TOOLS=a,b in .env (empty = show all).
const HIDDEN_MCP_TOOLS = (env.HIDE_MCP_TOOLS ?? 'add_note,complete_note,clear_notes,get_daily_briefing,add_running_note,search_running_notes').split(',').map((x) => x.trim()).filter(Boolean);
const MAX_TOOL_RESULT_CHARS = 30000;

const SYSTEM_PROMPT = `You are a helpful assistant for a Scrum Master on the Helsinki city web team (hel.fi).
You can use Jira/Confluence/Tempo tools. Use them whenever the user asks about tickets, sprints, hours or refinement.
Never invent ticket data: if a tool fails or returns nothing, say so.

Showing tool output (most important rule):
- When a tool returns a ready-made listing or report (refinement lists, sprint reports, hours, billing, process info),
  show it to the user EXACTLY as the tool returned it: the same words, language, order, grouping, headings, counts and symbols.
- Do not translate it, summarise it, shorten it, re-group it, add bullet points or dashes, or change things like "(4 tikettiä)" to "(4)".
- Do not add an introduction or commentary before it, and do not comment on missing links or fields. At most one short line after it,
  and only if something actually failed.
- Only change the format when the user explicitly asks for it (for example "summarise", "translate", "as a table", "only the epics").
- Ticket titles, epic names and other Jira/Confluence content always stay in their original language.
- In a step-by-step task (where you ask the user to confirm something before the next step), a short lookup result may be shown
  briefly as part of your question.
- If a tool result says the user cancelled it ("Peruit tämän toiminnon"), say so in one line, do not call it again,
  and ask briefly how they want to continue.

To-do list: when the user asks to add something to their to-do list / todo / muistilista (or to mark one done), use add_todo,
list_todos or complete_todo. These are the user's own to-dos in this app's Today panel, not Jira tickets or MCP notes.
Keep the user's wording for the to-do text (do not translate it). Confirm in one short line.

Language: the user prefers Finnish. Write your own sentences (when there is no ready-made output to show) in Finnish,
unless the user writes to you in another language, then answer in that language. Use Markdown.
If a tool returns ticket URLs, link the ticket keys with them.`;

// ───────────────────────── MCP ─────────────────────────
let mcp = null;
let mcpTools = [];
let mcpError = null;

async function connectMcp() {
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(MCP_DIR, 'server.mjs')],
      cwd: MCP_DIR, // the MCP loads its own .env from here
      env: { ...process.env },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d) => process.stderr.write(`[mcp] ${d}`));
    const client = new Client({ name: 'scrummaster-tool', version: '0.1.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    mcp = client;
    mcpTools = tools.filter((t) => (ALLOW_WRITE || t.annotations?.readOnlyHint === true) && !HIDDEN_MCP_TOOLS.includes(t.name));
    mcpError = null;
    console.log(`MCP connected: ${mcpTools.length}/${tools.length} tools exposed${ALLOW_WRITE ? '' : ' (read-only)'}`);
    transport.onclose = () => { mcp = null; mcpError = 'MCP server exited'; };
  } catch (e) {
    mcp = null;
    mcpError = `Could not start MCP at ${MCP_DIR}: ${e.message}`;
    console.error(mcpError);
  }
}

// A tool "writes" unless the MCP marks it readOnlyHint: true. Writing tools only run after the user clicks Allow.
const isWriteTool = (name) => mcpTools.find((t) => t.name === name)?.annotations?.readOnlyHint !== true;

// ─── Approvals: write tools wait here until the browser answers via POST /api/confirm ───
const APPROVAL_TIMEOUT_MS = 10 * 60_000; // no answer within 10 minutes = cancelled
const pendingApprovals = new Map(); // id -> resolve(true|false)

function waitForApproval(id, signal) {
  return new Promise((resolveApproval) => {
    const done = (allowed) => { clearTimeout(timer); pendingApprovals.delete(id); signal.removeEventListener('abort', onAbort); resolveApproval(allowed); };
    const onAbort = () => done(false); // browser closed / new chat
    const timer = setTimeout(() => done(false), APPROVAL_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort);
    pendingApprovals.set(id, done);
  });
}

const toOpenAiTools = () =>
  mcpTools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } },
  }));

// ─── The user's own to-dos (added from the chat or ticked in the Today panel) ───
// Stored in todos.json (git-ignored): [{ id, text, added: 'YYYY-MM-DD', doneOn: null | 'YYYY-MM-DD' }].
// Open items stay day after day; an item ticked done is still shown that day and dropped once the date changes.
const TODOS_FILE = join(here, 'todos.json');
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function loadTodos() {
  let items = [];
  try { items = JSON.parse(await readFile(TODOS_FILE, 'utf-8')); } catch {}
  const today = localDate();
  return Array.isArray(items) ? items.filter((t) => !t.doneOn || t.doneOn >= today) : [];
}
async function saveTodos(items) {
  await writeFile(TODOS_FILE + '.tmp', JSON.stringify(items, null, 2));
  await rename(TODOS_FILE + '.tmp', TODOS_FILE);
}
async function setTodoDone(id, done) {
  const items = await loadTodos();
  const t = items.find((x) => x.id === id);
  if (!t) return null;
  t.doneOn = done ? localDate() : null;
  await saveTodos(items);
  return t;
}

// To-do tools only touch todos.json, so they run without an Allow/Cancel step.
const TODO_TOOLS = [
  { name: 'add_todo', description: "Add an item to the user's own to-do list in this app (the Today panel). It stays on the list every day until the user ticks it done. Not for Jira tickets or MCP notes.",
    parameters: { type: 'object', properties: { text: { type: 'string', description: "The to-do, in the user's own words" } }, required: ['text'] } },
  { name: 'list_todos', description: "List the user's own to-dos in this app (open ones, and ones ticked done today), with their ids.",
    parameters: { type: 'object', properties: {} } },
  { name: 'complete_todo', description: "Mark one of the user's own to-dos done (or open again with done=false). Use list_todos first to find the id.",
    parameters: { type: 'object', properties: { id: { type: 'string' }, done: { type: 'boolean', description: 'Default true' } }, required: ['id'] } },
];

async function runTodoTool(name, args) {
  if (name === 'add_todo') {
    const text = String(args.text || '').trim().slice(0, 500);
    if (!text) throw new Error('text is required');
    const items = await loadTodos();
    const t = { id: randomUUID().slice(0, 8), text, added: localDate(), doneOn: null };
    items.push(t); await saveTodos(items);
    return `Lisätty tehtävä ${t.id}: ${t.text}`;
  }
  if (name === 'list_todos') {
    const items = await loadTodos();
    return items.length ? items.map((t) => `- [${t.doneOn ? 'x' : ' '}] ${t.id}: ${t.text} (lisätty ${t.added})`).join('\n') : 'Tehtävälista on tyhjä.';
  }
  if (name === 'complete_todo') {
    const t = await setTodoDone(String(args.id || ''), args.done !== false);
    if (!t) throw new Error(`No to-do with id ${args.id}`);
    return `${t.doneOn ? 'Tehty' : 'Avattu uudelleen'}: ${t.text}`;
  }
  throw new Error('Unknown to-do tool');
}

// ─── Sprint-change helpers: our own Jira/Confluence lookups + the quarter-pages script from the MCP folder ───
// Atlassian settings are read from the MCP's own .env (this folder's .env wins, same as for the MCP itself). Never logged.
function atl(key) {
  let file = {};
  try { file = parseEnv(readFileSync(join(MCP_DIR, '.env'))); } catch {}
  return env[key] || file[key] || '';
}
async function atlGet(url) {
  const auth = 'Basic ' + Buffer.from(`${atl('ATLASSIAN_EMAIL')}:${atl('ATLASSIAN_TOKEN')}`).toString('base64');
  const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Atlassian ${r.status} (${new URL(url).pathname})`);
  return r.json();
}
const fiDate = (iso) => (iso ? new Date(iso).toLocaleDateString('fi-FI') : '-');

async function getClosedSprints() {
  const board = atl('BOARD_ID'), jira = atl('JIRA_DOMAIN');
  if (!board || !jira) throw new Error('BOARD_ID or JIRA_DOMAIN is missing from the MCP .env');
  let all = [], startAt = 0;
  for (;;) { // the Agile API lists oldest first, 50 per page
    const d = await atlGet(`${jira}/rest/agile/1.0/board/${board}/sprint?state=closed&startAt=${startAt}&maxResults=50`);
    all.push(...(d.values || []));
    if (d.isLast || !d.values?.length) break;
    startAt += d.values.length;
  }
  const latest = all.sort((a, b) => new Date(b.completeDate || b.endDate || 0) - new Date(a.completeDate || a.endDate || 0)).slice(0, 3);
  if (!latest.length) return 'Suljettuja sprinttejä ei löytynyt.';
  return latest.map((s, i) => `${i === 0 ? 'Viimeisin suljettu' : 'Aiempi'}: ${s.name} (sprint ID ${s.id}, ${fiDate(s.startDate)}–${fiDate(s.completeDate || s.endDate)})`).join('\n');
}

async function findSprintPages(number) {
  const parent = atl('PARENT_PAGE_ID'), wiki = atl('CONFLUENCE_DOMAIN');
  if (!parent || !wiki) throw new Error('PARENT_PAGE_ID or CONFLUENCE_DOMAIN is missing from the MCP .env');
  let pages = [], start = 0;
  for (;;) {
    const d = await atlGet(`${wiki}/rest/api/content/${parent}/child/page?limit=100&start=${start}`);
    pages.push(...(d.results || []));
    if (!d._links?.next || !d.results?.length) break;
    start += d.results.length;
  }
  const n = String(number || '').replace(/\D/g, '');
  const re = n ? new RegExp(`(^|\\D)${n}(\\D|$)`) : null;
  const hits = re ? pages.filter((p) => re.test(p.title)) : [];
  const show = (p) => `- ${p.title} (page ID ${p.id}) ${wiki}${p._links?.webui || ''}`;
  const newest = [...pages].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 3);
  return (hits.length ? `Sivut, joiden otsikossa on ${n}:\n${hits.map(show).join('\n')}` : `Yhdenkään sivun otsikossa ei ole numeroa ${n}.`)
    + `\n\nUusimmat sprinttisivut:\n${newest.map(show).join('\n')}`;
}

// Same as `npm run updateQuarterPages -- <source> <target>` in the MCP folder.
const updateQuarterPages = (source, target) =>
  runMcpScript('updateQuarterPages.mjs', [num(source, 'source_page_id'), num(target, 'target_page_id')]);

// ─── Next sprint: number, dates and max person-days (htp) for the "ask for estimates" message ───
const ymd = (d) => localDate(d);
function easter(y) { // anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31);
  return new Date(y, mo - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
function finnishHolidays(y) { // public holidays that can fall on a weekday
  const e = easter(y), plus = (n) => new Date(e.getFullYear(), e.getMonth(), e.getDate() + n);
  const midsummerEve = [19, 20, 21, 22, 23, 24, 25].map((d) => new Date(y, 5, d)).find((d) => d.getDay() === 5);
  return new Map([
    [`${y}-01-01`, 'uudenvuodenpäivä'], [`${y}-01-06`, 'loppiainen'], [ymd(plus(-2)), 'pitkäperjantai'], [ymd(plus(1)), '2. pääsiäispäivä'],
    [`${y}-05-01`, 'vappu'], [ymd(plus(39)), 'helatorstai'], [ymd(midsummerEve), 'juhannusaatto'], [`${y}-12-06`, 'itsenäisyyspäivä'],
    [`${y}-12-24`, 'jouluaatto'], [`${y}-12-25`, 'joulupäivä'], [`${y}-12-26`, 'tapaninpäivä'],
  ]);
}
const fiShort = (d) => `${d.getDate()}.${d.getMonth() + 1}.`;

async function getNextSprintInfo() {
  const board = atl('BOARD_ID'), jira = atl('JIRA_DOMAIN');
  if (!board || !jira) throw new Error('BOARD_ID or JIRA_DOMAIN is missing from the MCP .env');
  const list = async (state) => (await atlGet(`${jira}/rest/agile/1.0/board/${board}/sprint?state=${state}&maxResults=50`)).values || [];
  const [active, future] = await Promise.all([list('active'), list('future')]);
  const cur = active.sort((a, b) => new Date(b.startDate) - new Date(a.startDate))[0];
  if (!cur) throw new Error('No active sprint on the board');
  const curNum = Number((cur.name.match(/\d+/) || [])[0]);
  const changeDay = new Date(cur.endDate); // sprint change day = the active sprint's end date
  // The next sprint runs Wednesday (day after the change) to Tuesday two weeks later; the end day counts as a working day.
  const start = new Date(changeDay.getFullYear(), changeDay.getMonth(), changeDay.getDate() + 1);
  const end = new Date(changeDay.getFullYear(), changeDay.getMonth(), changeDay.getDate() + 14);
  let lahipaivat = [];
  try {
    const cal = JSON.parse(await readFile(join(here, 'calendar.json'), 'utf-8'));
    lahipaivat = (cal.events || []).filter((e) => /lähipäiv/i.test(e.title)).map((e) => (e.allDay ? e.start : localDate(new Date(e.start))));
  } catch {}
  const holidays = new Map([...finnishHolidays(start.getFullYear()), ...finnishHolidays(end.getFullYear())]);
  let htp = 0; const skipped = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() % 6 === 0) continue;
    const k = ymd(d);
    if (holidays.has(k)) { skipped.push(`${fiShort(d)} ${holidays.get(k)}`); continue; }
    if (lahipaivat.includes(k)) { skipped.push(`${fiShort(d)} lähipäivä`); continue; }
    htp++;
  }
  const hasLahi = skipped.some((x) => x.endsWith('lähipäivä'));
  const nextNum = curNum ? curNum + 1 : '?';
  const message = `Valmistelen tänään sprintin #${nextNum} raporttipohjan. Laita oma htp-arviosi tähän threadiin, päivämäärät ovat ${fiShort(start)}–${fiShort(end)} `
    + `Tarkastelujaksolla voi olla yhteensä max ${htp} htp${hasLahi ? ' (+ lähipäivä)' : ''}.`;
  const calNote = lahipaivat.length ? '' : '\n(Kalenterista ei löytynyt lähipäivää; kalenteri kattaa vain seuraavat 2 viikkoa.)';
  return [
    `Käynnissä oleva sprintti: ${cur.name} (sprint ID ${cur.id}), päättyy ${fiDate(cur.endDate)}`,
    `Seuraava sprintti: #${nextNum}, ${fiShort(start)}–${fiShort(end)}, max ${htp} htp`
      + ` (ei laskettu: ${skipped.length ? skipped.join(', ') : 'ei pyhiä eikä lähipäiviä'})`,
    `Tulevat sprintit boardilla: ${future.map((f) => `${f.name} (sprint ID ${f.id})`).join(', ') || 'ei yhtään'}`,
    '', 'Valmis viesti #helfi_dev-kanavalle:', '```', message, '```',
  ].join('\n') + calNote;
}

// Runs one of the MCP folder's npm scripts (node <file> <args>) without a shell; `input` is typed into its prompts.
function runMcpScript(file, args = [], input = '') {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: MCP_DIR, env: process.env });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(out.trim() || 'Valmis.');
      else reject(new Error((err || out || `exit ${code}`).trim().slice(-3000)));
    });
    child.stdin.end(input);
  });
}
// cloneSprintTickets.mjs has no dry run and no duplicate check, so we check first: the template keys are read from
// the script's SOURCE_KEYS, their titles get "xx" -> sprint number, and we look for those titles in the sprint.
async function checkSprintTickets(sprintId, sprintNumber) {
  const jira = atl('JIRA_DOMAIN');
  const src = await readFile(join(MCP_DIR, 'cloneSprintTickets.mjs'), 'utf-8');
  const keys = [...((src.match(/SOURCE_KEYS\s*=\s*\[([^\]]*)\]/) || [])[1] || '').matchAll(/'([A-Z]+-\d+)'/g)].map((m) => m[1]);
  if (!keys.length) throw new Error('Could not read SOURCE_KEYS from cloneSprintTickets.mjs');
  const titles = await Promise.all(keys.map(async (k) => (await atlGet(`${jira}/rest/api/3/issue/${k}?fields=summary`)).fields.summary.replace(/xx/gi, sprintNumber)));
  const inSprint = ((await atlGet(`${jira}/rest/agile/1.0/sprint/${sprintId}/issue?fields=summary&maxResults=500`)).issues || [])
    .map((i) => ({ key: i.key, summary: i.fields.summary.trim() }));
  return keys.map((k, i) => ({ source: k, title: titles[i], existing: inSprint.find((x) => x.summary === titles[i].trim()) }));
}
async function previewSprintTickets(sprintId, sprintNumber) {
  const rows = await checkSprintTickets(sprintId, sprintNumber);
  return `[ESIKATSELU, mitään ei luoda] Sprintti ${sprintNumber} (sprint ID ${sprintId})\n` + rows.map((r) => (r.existing
    ? `⏭️  ${r.source}: sprintillä on jo ${r.existing.key} samalla otsikolla (${r.title})`
    : `➕ ${r.source}: luotaisiin "${r.title}"`)).join('\n');
}
async function cloneSprintTickets(sprintId, sprintNumber) {
  const dupes = (await checkSprintTickets(sprintId, sprintNumber)).filter((r) => r.existing);
  if (dupes.length) throw new Error(`Sprintillä on jo ${dupes.length} näistä tiketeistä (${dupes.map((d) => d.existing.key).join(', ')}), joten mitään ei luotu, ettei tule tuplia. Luo puuttuvat käsin.`);
  return runMcpScript('cloneSprintTickets.mjs', ['--sprint-id', sprintId, '--sprint-number', sprintNumber]);
}
const num = (x, what) => { const v = String(x ?? '').trim(); if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${what} must be a number`); return v; };

// Our own chat tools (not MCP). `write: true` = changes something outside the app: needs ALLOW_WRITE_TOOLS and the Allow card.
const LOCAL_TOOLS = [
  ...TODO_TOOLS.map((t) => ({ ...t, todos: t.name !== 'list_todos', run: (args) => runTodoTool(t.name, args) })),
  { name: 'get_closed_sprints', description: 'Get the most recently closed Jira sprints on the team board (name, sprint ID, dates). The first one is the sprint that just ended.',
    parameters: { type: 'object', properties: {} }, run: () => getClosedSprints() },
  { name: 'find_sprint_report_pages', description: 'Find Confluence sprint report pages (children of the sprint reports parent page) whose title contains a sprint number. Returns titles and page IDs, plus the newest pages.',
    parameters: { type: 'object', properties: { sprint_number: { type: 'string', description: 'The number in the sprint name, e.g. 122' } }, required: ['sprint_number'] },
    run: (a) => findSprintPages(a.sprint_number) },
  { name: 'get_next_sprint_info', description: 'Get the active sprint, the future sprints on the board (with sprint IDs), the next sprint number, its dates (Wed–Tue) and the max person-days (htp, holidays and lähipäivä excluded), plus a ready Slack message asking developers for their htp estimates.',
    parameters: { type: 'object', properties: {} }, run: () => getNextSprintInfo() },
  { name: 'get_sprint_capacity', description: 'Calculate how many story points fit in the coming sprint (total, FE, BE) from the velocity of the given closed sprint and the two before it (same as `npm run getSprintCapacity`). Read-only; takes a few minutes.',
    parameters: { type: 'object', properties: {
      closed_sprint_id: { type: 'string', description: 'Sprint ID of the latest closed sprint, e.g. 9290' },
      fe_htp: { type: 'string', description: 'Frontend htp estimate for the coming sprint (sum of all FE developers)' },
      be_htp: { type: 'string', description: 'Backend htp estimate for the coming sprint (sum of all BE developers)' } }, required: ['closed_sprint_id', 'fe_htp', 'be_htp'] },
    run: async (a) => (await runMcpScript('getSprintCapacity.mjs', [], [num(a.closed_sprint_id, 'closed_sprint_id'), num(a.fe_htp, 'fe_htp'), num(a.be_htp, 'be_htp')].join('\n') + '\n'))
      .replace(/^Mikä on viimeisin sprintti\?[^\n]*\n?/m, '').replace(/^Frontendin htp-arvio[^\n]*\n?/m, '') }, // drop the script's typed-in questions
  { name: 'preview_release_tickets', description: 'Preview which release tickets would be cloned to a sprint (same as `npm run cloneReleaseTickets -- --sprint-id X --dry-run`). Creates nothing.',
    parameters: { type: 'object', properties: { sprint_id: { type: 'string', description: 'Sprint ID of the new sprint (sprinttiaihio / aputaulukko)' } }, required: ['sprint_id'] },
    run: (a) => runMcpScript('cloneReleaseTickets.mjs', ['--sprint-id', num(a.sprint_id, 'sprint_id'), '--dry-run']) },
  { name: 'clone_release_tickets', write: true, description: 'Create the release tickets for a new sprint by cloning the template tickets (same as `npm run cloneReleaseTickets -- --sprint-id X`).',
    parameters: { type: 'object', properties: { sprint_id: { type: 'string', description: 'Sprint ID of the new sprint' } }, required: ['sprint_id'] },
    run: (a) => runMcpScript('cloneReleaseTickets.mjs', ['--sprint-id', num(a.sprint_id, 'sprint_id')]) },
  { name: 'preview_sprint_tickets', description: 'Preview the recurring meeting/admin tickets that clone_sprint_tickets would create for a sprint, and which already exist there. Creates nothing.',
    parameters: { type: 'object', properties: {
      sprint_id: { type: 'string', description: 'Sprint ID of the new sprint' },
      sprint_number: { type: 'string', description: 'Number of the new sprint, e.g. 126' } }, required: ['sprint_id', 'sprint_number'] },
    run: (a) => previewSprintTickets(num(a.sprint_id, 'sprint_id'), num(a.sprint_number, 'sprint_number')) },
  { name: 'clone_sprint_tickets', write: true, description: 'Create the recurring meeting/admin tickets for a new sprint ("xx" in titles becomes the sprint number) (same as `npm run cloneSprintTickets`). Refuses if any of them already exist in the sprint.',
    parameters: { type: 'object', properties: {
      sprint_id: { type: 'string', description: 'Sprint ID of the new sprint' },
      sprint_number: { type: 'string', description: 'Number of the new sprint, e.g. 126' } }, required: ['sprint_id', 'sprint_number'] },
    run: (a) => cloneSprintTickets(num(a.sprint_id, 'sprint_id'), num(a.sprint_number, 'sprint_number')) },
  { name: 'update_quarter_pages', write: true,
    description: 'Update the quarter pages in Confluence (same as `npm run updateQuarterPages`): writes quarter points to the source (epic overview) page and copies them to the target (pie chart) page.',
    parameters: { type: 'object', properties: {
      source_page_id: { type: 'string', description: 'Confluence page ID of the source page (epic overview with quarter points)' },
      target_page_id: { type: 'string', description: 'Confluence page ID of the target page (pie charts)' } }, required: ['source_page_id', 'target_page_id'] },
    run: (a) => updateQuarterPages(a.source_page_id, a.target_page_id) },
].filter((t) => ALLOW_WRITE || !t.write);

// ───────────────────────── Azure models ─────────────────────────
let modelCache = { at: 0, value: null };

// Premade fallback, used when the live lookup fails. Edit freely (or set AZURE_MODELS in .env).
const FALLBACK_MODELS = ['gpt-5-mini', 'gpt-5-nano', 'gpt-5', 'gpt-5.1', 'gpt-5.5', 'gpt-4o'];
// GDPR: deployments whose SKU is DataZoneStandard (EU data zone: processing stays in the EU).
// The key-only API can't report the SKU, so this is a snapshot (the UI's "Refresh" button replaces it with live `az` data) of `az cognitiveservices account deployment list`
// (sku.name). Anything not listed here is shown as "not confirmed EU" - update the list when deployments change,
// or override with DATA_ZONE_MODELS=gpt-5,gpt-5-mini in .env.
const DATA_ZONE_MODELS = (env.DATA_ZONE_MODELS ? env.DATA_ZONE_MODELS.split(',') : ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1', 'gpt-5.5'])
  .map((s) => s.trim()).filter(Boolean);
const REQUIRE_DATA_ZONE = env.REQUIRE_DATA_ZONE === 'true'; // true = hide and refuse non-data-zone models
const isDataZone = (id) => DATA_ZONE_MODELS.includes(id);
const NON_CHAT = /embedding|dall-e|tts|whisper|transcribe|realtime|audio|image|sora/i;
const asList = (ids, extra = {}) => ids.map((id) => ({ id, model: id }));

async function listModelsRaw() {
  if (modelCache.value && Date.now() - modelCache.at < 5 * 60_000) return modelCache.value;
  let value;
  if (env.AZURE_MODELS) {
    value = { source: 'env', models: asList(env.AZURE_MODELS.split(',').map((s) => s.trim()).filter(Boolean)) };
  } else {
    try {
      // The Azure resource key is enough to list deployments through the data-plane endpoint (no az login needed).
      const origin = new URL(BASE_URL).origin;
      const r = await fetch(`${origin}/openai/deployments?api-version=2023-03-15-preview`, { headers: { 'api-key': API_KEY }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const models = ((await r.json()).data || [])
        // Only OpenAI-family chat deployments: Claude etc. are not served by the OpenAI v1 endpoint.
        .filter((d) => d.status === 'succeeded' && /^(gpt|o\d)/i.test(d.model) && !NON_CHAT.test(d.model))
        .map((d) => ({ id: d.id, model: d.model }))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!models.length) throw new Error('no chat deployments found');
      value = { source: 'azure', models };
    } catch (e) {
      // Not cached long: retry on next page load
      return { source: 'fallback', warning: `Could not load live model list (${e.message}); showing the premade list.`, models: asList(FALLBACK_MODELS) };
    }
  }
  modelCache = { at: Date.now(), value };
  return value;
}

// ── Optional: verify SKU / data region with Azure CLI (button in the UI) ──
// Needs `az` installed, `az login`, and read access to the Foundry resource. Result is cached in .az-models.json.
const AZ_CACHE = join(here, '.az-models.json');
let azInfo = null; // { fetchedAt, account, deployments: { name: { sku, area, location, eu } } }
try { azInfo = JSON.parse(await readFile(AZ_CACHE, 'utf8')); } catch {}

async function refreshFromAz() {
  const az = (args) => run('az', [...args, '-o', 'json'], { timeout: 60000 }).then((r) => JSON.parse(r.stdout));
  const fail = (e) => {
    if (e.code === 'ENOENT') throw new Error('Azure CLI (az) ei ole asennettu tälle koneelle.');
    const m = (e.stderr || e.message || '').toString();
    if (/az login|AADSTS|Please run|credentials/i.test(m)) throw new Error('Et ole kirjautunut Azureen. Aja `az login` terminaalissa ja yritä uudelleen.');
    if (/AuthorizationFailed|does not have authorization|forbidden|403/i.test(m)) throw new Error('Azure-tililläsi ei ole oikeutta lukea tätä Foundry-resurssia.');
    throw new Error(`az epäonnistui: ${m.split('\n').find((l) => l.trim()) || e.message}`.slice(0, 300));
  };
  try {
    const name = new URL(BASE_URL).hostname.split('.')[0]; // account name = first label of the endpoint host
    const sub = env.AZURE_SUBSCRIPTION_ID ? ['--subscription', env.AZURE_SUBSCRIPTION_ID] : [];
    const accounts = await az(['cognitiveservices', 'account', 'list', ...sub]);
    const acc = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!acc) throw new Error(`Azure-resurssia "${name}" ei näy az-tilillesi/tilaukseesi (aseta AZURE_SUBSCRIPTION_ID .env-tiedostoon, jos käytät useampaa).`);
    const [, subId, rg] = acc.id.match(/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)/i);
    const deps = await az(['cognitiveservices', 'account', 'deployment', 'list', '--subscription', subId, '-g', rg, '-n', acc.name]);
    const deployments = {};
    for (const d of deps) {
      const sku = d.sku?.name || 'unknown', area = d.properties?.capabilities?.area || null;
      // EU processing = not a Global SKU and Microsoft says the area is EUR (data zone EU, or a regional deployment in an EU region)
      deployments[d.name] = { sku, area, location: acc.location, eu: !/^Global/i.test(sku) && area === 'EUR' };
    }
    azInfo = { fetchedAt: new Date().toISOString(), account: name, deployments };
    await writeFile(AZ_CACHE, JSON.stringify(azInfo, null, 2));
    modelCache = { at: 0, value: null };
    return { count: Object.keys(deployments).length, fetchedAt: azInfo.fetchedAt };
  } catch (e) { if (e.message?.startsWith('Azure-resurssia')) throw e; fail(e); }
}

// Is az installed and signed in? (used to enable/disable the option in the refresh dialog)
async function azStatus() {
  try {
    const { stdout } = await run('az', ['account', 'show', '-o', 'json'], { timeout: 15000 });
    return { installed: true, signedIn: true, user: JSON.parse(stdout).user?.name || null };
  } catch (e) {
    return e.code === 'ENOENT' ? { installed: false, signedIn: false } : { installed: true, signedIn: false };
  }
}

const regionLabel = (sku) => (/^DataZone/i.test(sku) ? 'EU-datavyöhyke' : /^Global/i.test(sku) ? 'Globaali (mikä tahansa alue)' : `Alueellinen (${azInfo?.deployments && Object.values(azInfo.deployments)[0]?.location || 'yksi alue'})`);

async function listModels() {
  const v = await listModelsRaw();
  let models = v.models.map((m) => {
    const info = azInfo?.deployments?.[m.id];
    if (info) return { ...m, dataZone: info.eu, verified: true, sku: info.sku, region: regionLabel(info.sku) };
    return { ...m, dataZone: isDataZone(m.id), verified: false };
  });
  if (REQUIRE_DATA_ZONE) models = models.filter((m) => m.dataZone);
  return { ...v, models, requireDataZone: REQUIRE_DATA_ZONE, verifiedAt: azInfo?.fetchedAt || null };
}

// ───────────────────────── Reasoning levels per model ─────────────────────────
// Not every model supports reasoning_effort, and the accepted values differ. Instead of a hard-coded table we probe the
// deployment once (tiny requests, 16 tokens) and remember the answer until the server restarts.
const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const reasoningCache = new Map();

async function probeReasoning(model) {
  if (reasoningCache.has(model)) return reasoningCache.get(model);
  const results = await Promise.all(REASONING_LEVELS.map(async (level) => {
    try {
      const r = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST', headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 16, reasoning_effort: level }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return [level, true];
      if (r.status === 400) return [level, false];
    } catch {}
    return [level, null]; // unknown (rate limit, timeout...)
  }));
  const unknown = results.some(([, v]) => v === null);
  const value = { levels: results.filter(([, v]) => v !== false).map(([l]) => l), probed: !unknown };
  if (!unknown) reasoningCache.set(model, value); // don't cache an uncertain answer
  return value;
}

// ───────────────────────── Chat loop ─────────────────────────
async function callModel({ model, effort, messages, tools }) {
  const body = { model, messages, max_completion_tokens: 8000 };
  if (tools.length) body.tools = tools;
  if (effort && effort !== 'default') body.reasoning_effort = effort;

  let retries = 0, droppedEffort = false;
  for (;;) {
    const r = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (r.ok) return { json: await r.json(), droppedEffort };
    const text = await r.text();
    // Non-reasoning models (e.g. gpt-4o) reject reasoning_effort: retry once without it.
    if (r.status === 400 && body.reasoning_effort && /reasoning_effort/i.test(text)) { delete body.reasoning_effort; droppedEffort = true; continue; }
    // Transient Azure errors (429 / 5xx / network): back off and retry up to 3 times.
    if ([0, 429, 500, 502, 503, 504].includes(r.status) && retries < 3) {
      const wait = Number(r.headers?.get?.('retry-after')) * 1000 || 1000 * 2 ** retries;
      await new Promise((ok) => setTimeout(ok, Math.min(wait, 10000))); retries++; continue;
    }
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch {}
    throw new Error(`Azure ${r.status}: ${msg.slice(0, 500)}`);
  }
}

async function chat({ model, effort, history }, emit, signal) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  const tools = [...LOCAL_TOOLS.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })), ...(mcp ? toOpenAiTools() : [])];
  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) return;
    const { json, droppedEffort } = await callModel({ model, effort, messages, tools: round === MAX_TOOL_ROUNDS ? [] : tools });
    if (droppedEffort && round === 0) emit({ type: 'notice', text: `${model} ei tue päättelytasoja; käytettiin oletusta.` });
    usage.prompt_tokens += json.usage?.prompt_tokens || 0;
    usage.completion_tokens += json.usage?.completion_tokens || 0;
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error('Empty response from model');

    if (!msg.tool_calls?.length) {
      emit({ type: 'message', content: msg.content || '', usage });
      return;
    }
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      emit({ type: 'tool_call', id: call.id, name: call.function.name, args });
      let text, isError = false;
      const local = LOCAL_TOOLS.find((t) => t.name === call.function.name);
      try {
        if (!local && (!mcp || !mcpTools.some((t) => t.name === call.function.name))) throw new Error('Tool not available');
        if (local ? local.write : isWriteTool(call.function.name)) {
          const approvalId = randomUUID();
          const description = local ? local.description : mcpTools.find((t) => t.name === call.function.name)?.description || '';
          emit({ type: 'confirm', id: approvalId, callId: call.id, name: call.function.name, description, args });
          if (!(await waitForApproval(approvalId, signal))) {
            emit({ type: 'tool_result', id: call.id, name: call.function.name, ok: false, preview: 'Peruit tämän, mitään ei muutettu.' });
            messages.push({ role: 'tool', tool_call_id: call.id, content: 'Peruit tämän toiminnon, joten mitään ei muutettu.' });
            continue;
          }
        }
        if (local) {
          text = await local.run(args);
        } else {
          // Long timeout: sprint page updates fetch a lot from Jira and Tempo.
          const res = await mcp.callTool({ name: call.function.name, arguments: args }, undefined, { timeout: 10 * 60_000 });
          text = (res.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
          isError = !!res.isError;
        }
      } catch (e) { text = `Työkaluvirhe: ${e.message}`; isError = true; }
      if (local?.todos && !isError) emit({ type: 'todos_changed' });
      // The page gets the whole output (shown in the tool's toggle); only the copy sent to the model is capped.
      emit({ type: 'tool_result', id: call.id, name: call.function.name, ok: !isError, preview: text });
      if (text.length > MAX_TOOL_RESULT_CHARS) text = text.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]';
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
    }
  }
}

// ───────────────────────── HTTP ─────────────────────────
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

async function readBody(req, limit = 1_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Request too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

// Fixed list of extra files in public/ that may be served (no general file serving).
const STATIC_FILES = {
  '/manifest.webmanifest': 'application/manifest+json',
  '/icon.svg': 'image/svg+xml',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  try {
    // Only accept requests addressed to localhost (blocks DNS-rebinding) and same-origin POSTs (blocks other sites in the browser).
    const host = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return json(res, 403, { error: 'Forbidden' });
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: 'Forbidden' });

    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(join(here, 'public/index.html')));
    }
    // App icon + manifest, so Chrome/Edge can "Install" the page as its own app window.
    if (req.method === 'GET' && STATIC_FILES[pathname]) {
      res.writeHead(200, { 'Content-Type': STATIC_FILES[pathname], 'Cache-Control': 'max-age=3600' });
      return res.end(await readFile(join(here, 'public', pathname.slice(1))));
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      return json(res, 200, {
        azureConfigured: !!(BASE_URL && API_KEY),
        defaultModel: env.DEFAULT_MODEL || null,
        mcp: { connected: !!mcp, error: mcpError, readOnly: !ALLOW_WRITE },
      });
    }
    if (req.method === 'GET' && pathname === '/api/models') {
      try { return json(res, 200, await listModels()); } catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (req.method === 'GET' && pathname === '/api/calendar') {
      // Written each morning by the Claude scheduled task via scripts/save-calendar.mjs. Missing = no calendar rules.
      try { return json(res, 200, JSON.parse(await readFile(join(here, 'calendar.json'), 'utf-8'))); }
      catch { return json(res, 200, { updatedAt: null, events: [] }); }
    }
    if (req.method === 'GET' && pathname === '/api/todos') {
      return json(res, 200, { today: localDate(), items: await loadTodos() });
    }
    if (req.method === 'POST' && pathname === '/api/todos/done') {
      const { id, done } = await readBody(req);
      const t = await setTodoDone(String(id || ''), done === true);
      return t ? json(res, 200, { ok: true, item: t }) : json(res, 404, { error: 'No such to-do' });
    }
    if (req.method === 'GET' && pathname === '/api/reasoning') {
      const model = new URL(req.url, 'http://localhost').searchParams.get('model');
      if (!(await listModels()).models.some((m) => m.id === model)) return json(res, 404, { error: 'Unknown model' });
      return json(res, 200, await probeReasoning(model));
    }
    if (req.method === 'GET' && pathname === '/api/az/status') return json(res, 200, await azStatus());
    if (req.method === 'POST' && pathname === '/api/models/refresh') {
      try {
        const { source } = await readBody(req);
        if (source === 'az') return json(res, 200, await refreshFromAz());
        modelCache = { at: 0, value: null }; // 'api': just re-ask Azure with the API key
        const v = await listModels();
        return json(res, 200, { count: v.models.length, source: v.source });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (req.method === 'GET' && pathname === '/api/tools') {
      return json(res, 200, { tools: [...LOCAL_TOOLS, ...mcpTools].map((t) => ({ name: t.name, description: t.description })) });
    }
    if (req.method === 'POST' && pathname === '/api/confirm') {
      const { id, allow } = await readBody(req);
      const answer = pendingApprovals.get(id);
      if (!answer) return json(res, 404, { error: 'This request has expired or was already answered' });
      answer(allow === true);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/chat') {
      const { model, effort, history } = await readBody(req);
      if (!model || !Array.isArray(history) || !history.length) return json(res, 400, { error: 'model and history required' });
      if (REQUIRE_DATA_ZONE && !isDataZone(model)) return json(res, 403, { error: `${model} is not a confirmed EU data-zone deployment (REQUIRE_DATA_ZONE=true)` });
      if (!BASE_URL || !API_KEY) return json(res, 503, { error: 'Azure is not configured (see .env)' });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const emit = (ev) => !res.writableEnded && res.write(JSON.stringify(ev) + '\n');
      try { await chat({ model, effort, history }, emit, ac.signal); }
      catch (e) { emit({ type: 'error', error: e.message }); }
      return res.end();
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message }); else res.end();
  }
});

await connectMcp();
server.listen(PORT, '127.0.0.1', () => console.log(`Scrummaster tool: http://localhost:${PORT}`));
process.on('SIGINT', async () => { await mcp?.close().catch(() => {}); process.exit(0); });
