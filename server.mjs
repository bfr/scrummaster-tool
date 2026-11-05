// Scrummaster tool backend.
//  - serves public/index.html
//  - GET  /api/models  -> chat deployments from Azure Foundry
//  - GET  /api/tools   -> tools exposed by the Atlassian MCP
//  - POST /api/chat    -> runs the model <-> MCP tool-calling loop, streams NDJSON events
// Keys never leave this process. Binds to localhost only.
import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const PORT = Number(env.PORT || 3000);
const BASE_URL = (env.AOAI_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = env.AZURE_API_KEY || '';
const MCP_DIR = resolve(here, env.JIRA_MCP_DIR || './mcp/jira-to-confluence');
const ALLOW_WRITE = env.ALLOW_WRITE_TOOLS === 'true';
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_RESULT_CHARS = 30000;

const SYSTEM_PROMPT = `You are a helpful assistant for a Scrum Master on the Helsinki city web team (hel.fi).
You can use Jira/Confluence/Tempo tools. Use them whenever the user asks about tickets, sprints, hours or refinement.
Never invent ticket data: if a tool fails or returns nothing, say so. Answer in the language the user writes in.
Format answers in Markdown. Link ticket keys using the URLs the tools return.`;

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
    mcpTools = tools.filter((t) => ALLOW_WRITE || t.annotations?.readOnlyHint === true);
    mcpError = null;
    console.log(`MCP connected: ${mcpTools.length}/${tools.length} tools exposed${ALLOW_WRITE ? '' : ' (read-only)'}`);
    transport.onclose = () => { mcp = null; mcpError = 'MCP server exited'; };
  } catch (e) {
    mcp = null;
    mcpError = `Could not start MCP at ${MCP_DIR}: ${e.message}`;
    console.error(mcpError);
  }
}

const toOpenAiTools = () =>
  mcpTools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } },
  }));

// ───────────────────────── Azure models ─────────────────────────
let modelCache = { at: 0, value: null };

// Premade fallback, used when the live lookup fails. Edit freely (or set AZURE_MODELS in .env).
const FALLBACK_MODELS = ['gpt-5-mini', 'gpt-5-nano', 'gpt-5', 'gpt-5.1', 'gpt-5.5', 'gpt-4o'];
// GDPR: deployments whose SKU is DataZoneStandard (EU data zone: processing stays in the EU).
// The key-only API can't report the SKU, so this is a snapshot of `az cognitiveservices account deployment list`
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

async function listModels() {
  const v = await listModelsRaw();
  let models = v.models.map((m) => ({ ...m, dataZone: isDataZone(m.id) }));
  if (REQUIRE_DATA_ZONE) models = models.filter((m) => m.dataZone);
  return { ...v, models, requireDataZone: REQUIRE_DATA_ZONE };
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
  const tools = mcp ? toOpenAiTools() : [];
  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) return;
    const { json, droppedEffort } = await callModel({ model, effort, messages, tools: round === MAX_TOOL_ROUNDS ? [] : tools });
    if (droppedEffort && round === 0) emit({ type: 'notice', text: `${model} does not support reasoning levels; used its default.` });
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
      try {
        if (!mcp || !mcpTools.some((t) => t.name === call.function.name)) throw new Error('Tool not available');
        const res = await mcp.callTool({ name: call.function.name, arguments: args }, undefined, { timeout: 120000 });
        text = (res.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
        isError = !!res.isError;
      } catch (e) { text = `Tool error: ${e.message}`; isError = true; }
      if (text.length > MAX_TOOL_RESULT_CHARS) text = text.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]';
      emit({ type: 'tool_result', id: call.id, name: call.function.name, ok: !isError, preview: text.slice(0, 1500) });
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
    if (req.method === 'GET' && pathname === '/api/tools') {
      return json(res, 200, { tools: mcpTools.map((t) => ({ name: t.name, description: t.description })) });
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
