// gradient goat API (Cloudflare Pages Function)
//
//   GET  /api/config                         -> {googleClientId}
//   POST /api/auth/google  {credential}       -> me         verify a Google sign-in, start a session
//   GET  /api/me                              -> me         {signedIn, username, tag, showTag}
//   POST /api/me           {username?, showTag?} -> me      username can be set once; showTag any time
//   POST /api/logout                          -> {ok}
//   POST /api/start        {board}            -> {token}    signed when a run starts
//   POST /api/scores       {token, score}     -> {ok, rank, best}   signed-in players only
//   GET  /api/scores?board=1:60[&tag=Berkeley] -> {top:[{name, tag, score}]}
//   GET  /api/schools?board=1:60              -> {schools:[{tag, players}], ranking:[{tag, avg, players}]}
//
// Bindings: DB (D1). Vars: GOOGLE_CLIENT_ID (public OAuth client ID).
// Run tokens are signed with a key generated on first use and kept in the database.

const LEVELS = ['1', '2', '3', '4', 'ml', 'nn', 'tf', 'rnn', 'rl', 'all'];
const DURATIONS = [15, 30, 60, 120, 300];
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;
const MAX_PER_SECOND = 1.0;          // no human answers faster than this, sustained
const SUBMIT_WINDOW_MS = 10 * 60e3;  // time allowed after the run ends to submit
const SESSION_COOKIE = 'gg_session';
const SESSION_MAX_AGE = 365 * 24 * 3600;
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

/* ---------- helpers ---------- */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

function parseBoard(board) {
  if (typeof board !== 'string') return null;
  const [level, d] = board.split(':');
  const dur = Number(d);
  if (!LEVELS.includes(level) || !DURATIONS.includes(dur)) return null;
  return { level, dur };
}

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' })[c]);
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
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
    await env.DB.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('hmac', ?)").bind(hex(crypto.getRandomValues(new Uint8Array(32)))).run();
    row = await env.DB.prepare("SELECT v FROM config WHERE k = 'hmac'").first();
  }
  return (cachedKey = row.v);
}

async function readJson(request) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) return null;
  if (Number(request.headers.get('content-length') || 0) > 8192) return null;
  try { return await request.json(); } catch { return null; }
}

/* ---------- verified school tags from Google Workspace domains ---------- */
const KNOWN = {
  'berkeley.edu': 'Berkeley', 'stanford.edu': 'Stanford', 'mit.edu': 'MIT', 'cmu.edu': 'CMU', 'harvard.edu': 'Harvard',
  'princeton.edu': 'Princeton', 'caltech.edu': 'Caltech', 'uw.edu': 'UW', 'washington.edu': 'UW', 'ucla.edu': 'UCLA',
  'ucsd.edu': 'UCSD', 'utexas.edu': 'UT Austin', 'umich.edu': 'Michigan', 'cornell.edu': 'Cornell', 'columbia.edu': 'Columbia',
  'upenn.edu': 'Penn', 'yale.edu': 'Yale', 'gatech.edu': 'Georgia Tech', 'illinois.edu': 'UIUC', 'nyu.edu': 'NYU',
  'uchicago.edu': 'UChicago', 'usc.edu': 'USC', 'ucdavis.edu': 'UC Davis', 'uci.edu': 'UC Irvine', 'ucsb.edu': 'UCSB',
  'ucsc.edu': 'UC Santa Cruz', 'brown.edu': 'Brown', 'duke.edu': 'Duke', 'jhu.edu': 'Johns Hopkins', 'northwestern.edu': 'Northwestern',
  'wisc.edu': 'Wisconsin', 'purdue.edu': 'Purdue', 'umd.edu': 'Maryland', 'rice.edu': 'Rice', 'virginia.edu': 'UVA',
  'unc.edu': 'UNC', 'dartmouth.edu': 'Dartmouth', 'vanderbilt.edu': 'Vanderbilt', 'utoronto.ca': 'Toronto', 'uwaterloo.ca': 'Waterloo',
  'mcgill.ca': 'McGill', 'ubc.ca': 'UBC', 'ox.ac.uk': 'Oxford', 'cam.ac.uk': 'Cambridge', 'imperial.ac.uk': 'Imperial',
  'ucl.ac.uk': 'UCL', 'ethz.ch': 'ETH Zürich', 'epfl.ch': 'EPFL', 'tsinghua.edu.cn': 'Tsinghua', 'nus.edu.sg': 'NUS',
};
// academic domains: .edu, .edu.xx, .ac.xx, plus the listed schools outside those suffixes
const isSchool = d => /\.edu$/.test(d) || /\.(edu|ac)\.[a-z]{2}$/.test(d) || d in KNOWN;
const TWO_LEVEL = /\.(ac|co|edu|gov|org|com)\.[a-z]{2}$/;
function orgDomain(d) {
  const labels = d.toLowerCase().split('.');
  return labels.slice(TWO_LEVEL.test(d.toLowerCase()) ? -3 : -2).join('.');
}
function tagFor(claims) {
  // `hd` is only present for Google Workspace accounts (schools, companies), never for personal Gmail
  if (typeof claims.hd !== 'string' || !claims.hd) return { domain: null, tag: null };
  const email = String(claims.email || '').toLowerCase();
  if (!email.endsWith('@' + claims.hd.toLowerCase()) && !email.endsWith('.' + claims.hd.toLowerCase())) return { domain: null, tag: null };
  const d = orgDomain(claims.hd);
  if (!isSchool(d)) return { domain: null, tag: null }; // work accounts sign in fine but get no tag
  return { domain: d, tag: KNOWN[d] || d };
}

/* ---------- Google ID token verification ---------- */
let jwksCache = { at: 0, keys: null };
async function googleKeys(env) {
  if (env.TEST_JWKS) return JSON.parse(env.TEST_JWKS).keys; // local testing only
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600e3) return jwksCache.keys;
  const r = await fetch(GOOGLE_JWKS);
  if (!r.ok) throw new Error('jwks');
  jwksCache = { at: Date.now(), keys: (await r.json()).keys };
  return jwksCache.keys;
}
async function verifyGoogle(credential, env) {
  if (typeof credential !== 'string') return null;
  const parts = credential.split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch { return null; }
  if (header.alg !== 'RS256') return null;
  const jwk = (await googleKeys(env)).find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  const now = Date.now() / 1000;
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) return null;
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!(claims.exp > now) || (claims.iat && claims.iat > now + 300)) return null;
  if (claims.email_verified !== true || typeof claims.sub !== 'string') return null;
  return claims;
}

/* ---------- sessions ---------- */
function cookieValue(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
const sessionCookie = (value, maxAge) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function currentUser(request, env) {
  const raw = cookieValue(request, SESSION_COOKIE);
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
  return env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?').bind(await sha256(raw)).first();
}
const meOf = u => u
  ? { signedIn: true, username: u.username || null, tag: u.tag || null, showTag: !!u.show_tag }
  : { signedIn: false };

async function authGoogle(request, env) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: 'sign-in is not set up yet' }, 503);
  const body = await readJson(request);
  const claims = body && await verifyGoogle(body.credential, env);
  if (!claims) return json({ error: 'sign-in failed' }, 401);
  const { domain, tag } = tagFor(claims);
  const now = Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO users (google_sub, domain, tag, show_tag, created) VALUES (?, ?, ?, 1, ?)')
    .bind(claims.sub, domain, tag, now).run();
  // keep the verified org current if the account's Workspace domain changes
  await env.DB.prepare('UPDATE users SET domain = ?, tag = ? WHERE google_sub = ?').bind(domain, tag, claims.sub).run();
  const user = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(claims.sub).first();
  const raw = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO sessions (hash, user_id, created) VALUES (?, ?, ?)').bind(await sha256(raw), user.id, now).run();
  return json(meOf(user), 200, { 'set-cookie': sessionCookie(raw, SESSION_MAX_AGE) });
}

async function updateMe(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'sign in first' }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: 'bad request' }, 400);
  if (body.username !== undefined) {
    if (user.username) return json({ error: 'username is already set' }, 409);
    const name = String(body.username).trim();
    if (!USERNAME_RE.test(name)) return json({ error: 'username: 3–16 letters, digits, . _ -' }, 400);
    const r = await env.DB.prepare('UPDATE users SET username = ? WHERE id = ? AND username IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE username = ? COLLATE NOCASE)')
      .bind(name, user.id, name).run();
    if (!r.meta.changes) return json({ error: 'that username is taken' }, 409);
  }
  if (body.showTag !== undefined) {
    await env.DB.prepare('UPDATE users SET show_tag = ? WHERE id = ?').bind(body.showTag ? 1 : 0, user.id).run();
  }
  return json(meOf(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first()));
}

async function logout(request, env) {
  const raw = cookieValue(request, SESSION_COOKIE);
  if (raw && /^[0-9a-f]{64}$/.test(raw)) await env.DB.prepare('DELETE FROM sessions WHERE hash = ?').bind(await sha256(raw)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

/* ---------- runs and scores ---------- */
async function start(request, env) {
  const body = await readJson(request);
  if (!body || !parseBoard(body.board)) return json({ error: 'bad board' }, 400);
  const payload = `${crypto.randomUUID()}.${body.board}.${Date.now()}`;
  return json({ token: `${payload}.${await hmac(await signingKey(env), payload)}` });
}

async function submit(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'sign in to post scores' }, 401);
  if (!user.username) return json({ error: 'pick a username first' }, 409);
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

  const used = await env.DB.prepare('INSERT OR IGNORE INTO used_tokens (id, created) VALUES (?, ?)').bind(id, Date.now()).run();
  if (!used.meta.changes) return json({ error: 'already submitted' }, 409);
  await env.DB.prepare('INSERT INTO scores (board, user_id, score, created) VALUES (?, ?, ?, ?)').bind(board, user.id, score, Date.now()).run();

  const mine = await env.DB.prepare('SELECT MAX(score) AS best FROM scores WHERE board = ? AND user_id = ?').bind(board, user.id).first();
  const best = mine?.best ?? score;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM (SELECT user_id, MAX(score) AS s FROM scores WHERE board = ? GROUP BY user_id) WHERE s > ?'
  ).bind(board, best).first();
  return json({ ok: true, rank: (row?.n ?? 0) + 1, best });
}

async function top(url, env) {
  const board = url.searchParams.get('board');
  if (!parseBoard(board)) return json({ error: 'bad board' }, 400);
  const tag = url.searchParams.get('tag');
  if (tag !== null && (tag.length < 1 || tag.length > 64)) return json({ error: 'bad tag' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT u.username AS name, CASE WHEN u.show_tag = 1 THEN u.tag END AS tag, MAX(s.score) AS score, MIN(s.created) AS created
       FROM scores s JOIN users u ON u.id = s.user_id
      WHERE s.board = ?1 AND (?2 IS NULL OR (u.tag = ?2 AND u.show_tag = 1))
      GROUP BY s.user_id ORDER BY score DESC, created ASC LIMIT 10`
  ).bind(board, tag).all();
  return json({ top: results.map(r => ({ name: r.name, tag: r.tag || null, score: r.score })) });
}

async function schools(url, env) {
  const board = url.searchParams.get('board');
  if (!parseBoard(board)) return json({ error: 'bad board' }, 400);
  const best = `WITH best AS (
      SELECT u.tag AS tag, s.user_id AS uid, MAX(s.score) AS b
        FROM scores s JOIN users u ON u.id = s.user_id
       WHERE s.board = ?1 AND u.show_tag = 1 AND u.tag IS NOT NULL
       GROUP BY s.user_id)`;
  const list = await env.DB.prepare(`${best} SELECT tag, COUNT(*) AS players FROM best GROUP BY tag ORDER BY players DESC, tag ASC LIMIT 200`).bind(board).all();
  // school ranking: average of each school's top 5 players, schools with at least 3 players
  const rank = await env.DB.prepare(`${best},
      ranked AS (SELECT tag, b, ROW_NUMBER() OVER (PARTITION BY tag ORDER BY b DESC) AS rn, COUNT(*) OVER (PARTITION BY tag) AS n FROM best)
      SELECT tag, AVG(b) AS avg, MAX(n) AS players FROM ranked WHERE rn <= 5 GROUP BY tag HAVING MAX(n) >= 3
      ORDER BY avg DESC, players DESC LIMIT 20`).bind(board).all();
  return json({
    schools: list.results.map(r => ({ tag: r.tag, players: r.players })),
    ranking: rank.results.map(r => ({ tag: r.tag, avg: Math.round(r.avg * 10) / 10, players: r.players })),
  });
}

export async function onRequest({ request, env }) {
  if (!env.DB) return json({ error: 'leaderboard not configured' }, 503);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  try {
    if (path === '/api/config' && m === 'GET') return json({ googleClientId: env.GOOGLE_CLIENT_ID || null });
    if (path === '/api/auth/google' && m === 'POST') return await authGoogle(request, env);
    if (path === '/api/me' && m === 'GET') return json(meOf(await currentUser(request, env)));
    if (path === '/api/me' && m === 'POST') return await updateMe(request, env);
    if (path === '/api/logout' && m === 'POST') return await logout(request, env);
    if (path === '/api/start' && m === 'POST') return await start(request, env);
    if (path === '/api/scores' && m === 'POST') return await submit(request, env);
    if (path === '/api/scores' && m === 'GET') return await top(url, env);
    if (path === '/api/schools' && m === 'GET') return await schools(url, env);
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: 'server error' }, 500);
  }
}
