// gradmac leaderboard API (Cloudflare Pages Function)
//
//   POST /api/start   {board}               -> {token}        signed when a run starts
//   POST /api/scores  {token, name, score}  -> {ok, rank}     one submission per token
//   GET  /api/scores?board=1:60             -> {top:[{name, score}]}
//
// Binding: DB (D1 database). Run tokens are signed with a key kept in the database,
// created on first use (or with the SECRET environment variable, if one is set).

const LEVELS = ['1', '2', '3', '4', 'all'];
const DURATIONS = [15, 30, 60, 120, 300];
const NAME_RE = /^[A-Za-z0-9_.\- ]{1,16}$/;
const MAX_PER_SECOND = 1.2;          // no human answers faster than this, sustained
const SUBMIT_WINDOW_MS = 10 * 60e3;  // time allowed after the run ends to submit

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function parseBoard(board) {
  if (typeof board !== 'string') return null;
  const [level, d] = board.split(':');
  const dur = Number(d);
  if (!LEVELS.includes(level) || !DURATIONS.includes(dur)) return null;
  return { level, dur };
}

const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' })[c]);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

let cachedKey = null;
async function signingKey(env) {
  if (env.SECRET) return env.SECRET;
  if (cachedKey) return cachedKey;
  let row = await env.DB.prepare("SELECT v FROM config WHERE k = 'hmac'").first();
  if (!row) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const fresh = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('hmac', ?)").bind(fresh).run();
    row = await env.DB.prepare("SELECT v FROM config WHERE k = 'hmac'").first();
  }
  return (cachedKey = row.v);
}

async function readJson(request) {
  if (Number(request.headers.get('content-length') || 0) > 2048) return null;
  try { return await request.json(); } catch { return null; }
}

async function start(request, env) {
  const body = await readJson(request);
  if (!body || !parseBoard(body.board)) return json({ error: 'bad board' }, 400);
  const payload = `${crypto.randomUUID()}.${body.board}.${Date.now()}`;
  return json({ token: `${payload}.${await hmac(await signingKey(env), payload)}` });
}

async function submit(request, env) {
  const body = await readJson(request);
  if (!body || typeof body.token !== 'string') return json({ error: 'bad request' }, 400);
  const parts = body.token.split('.');
  if (parts.length !== 4) return json({ error: 'bad token' }, 400);
  const [id, board, t, sig] = parts;
  if (!safeEqual(sig, await hmac(await signingKey(env), `${id}.${board}.${t}`))) return json({ error: 'bad token' }, 400);

  const b = parseBoard(board);
  if (!b) return json({ error: 'bad board' }, 400);
  const elapsed = Date.now() - Number(t);
  if (!(elapsed >= b.dur * 1000 - 1500)) return json({ error: 'run not finished' }, 400);
  if (elapsed > b.dur * 1000 + SUBMIT_WINDOW_MS) return json({ error: 'token expired' }, 400);

  const score = body.score;
  if (!Number.isInteger(score) || score < 1 || score > Math.ceil(b.dur * MAX_PER_SECOND)) return json({ error: 'bad score' }, 400);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!NAME_RE.test(name)) return json({ error: 'name: 1–16 letters, digits, spaces, . _ -' }, 400);

  // each run token can be used once
  const used = await env.DB.prepare('INSERT OR IGNORE INTO used_tokens (id, created) VALUES (?, ?)').bind(id, Date.now()).run();
  if (!used.meta.changes) return json({ error: 'already submitted' }, 409);

  await env.DB.prepare('INSERT INTO scores (board, name, score, created) VALUES (?, ?, ?, ?)')
    .bind(board, name, score, Date.now()).run();
  const mine = await env.DB.prepare('SELECT MAX(score) AS best FROM scores WHERE board = ? AND name = ?').bind(board, name).first();
  const best = mine?.best ?? score;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM (SELECT name, MAX(score) AS s FROM scores WHERE board = ? GROUP BY name) WHERE s > ?'
  ).bind(board, best).first();
  return json({ ok: true, rank: (row?.n ?? 0) + 1, best });
}

async function top(url, env) {
  const board = url.searchParams.get('board');
  if (!parseBoard(board)) return json({ error: 'bad board' }, 400);
  const { results } = await env.DB.prepare(
    'SELECT name, MAX(score) AS score, MIN(created) AS created FROM scores WHERE board = ? GROUP BY name ORDER BY score DESC, created ASC LIMIT 10'
  ).bind(board).all();
  return new Response(JSON.stringify({ top: results.map(r => ({ name: r.name, score: r.score })) }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=15' },
  });
}

export async function onRequest({ request, env }) {
  if (!env.DB) return json({ error: 'leaderboard not configured' }, 503);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path === '/api/start' && request.method === 'POST') return await start(request, env);
    if (path === '/api/scores' && request.method === 'POST') return await submit(request, env);
    if (path === '/api/scores' && request.method === 'GET') return await top(url, env);
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: 'server error' }, 500);
  }
}
