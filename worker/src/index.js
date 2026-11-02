// Pitch Count Passport API — Cloudflare Worker + D1.
//
// Security model
//  - Passwords: PBKDF2-SHA256, 100k iterations, 16-byte random salt, constant-time compare.
//  - Sessions: 256-bit random bearer tokens; only SHA-256(token) is stored. 30-day sliding expiry.
//  - Login lockout per account (5 fails → 15 min) + per-IP throttles on signup/login.
//  - Every player/outing route checks the caller's role on that player (owner / coach / viewer).
//  - Strict CORS allowlist, no-store, nosniff, generic 500s (no stack traces leave the box).
//  - All inputs length-limited and type-checked; all SQL is parameterized.

import { computeStatus, isYmd, todayLocal } from '../../rules.js';

const ALLOWED_ORIGINS = [
  'https://keubanks16.github.io',
  'http://localhost:8787',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];
const PBKDF2_ITER = 100000;              // Workers caps PBKDF2 at 100k iterations
const SESSION_MS = 30 * 24 * 3600 * 1000;
const SESSION_RENEW_MS = 15 * 24 * 3600 * 1000;
const LOCK_AFTER = 5, LOCK_MS = 15 * 60 * 1000;
const THROTTLE = { login: [20, 15 * 60], signup: [5, 60 * 60], link: [20, 15 * 60] }; // [max, windowSec]
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 25, MAX_OUTINGS = 2000, MAX_COACHES = 20;
const ROLES = ['coach', 'viewer'];

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(req, env, ctx);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'Server error' : e.message }, status, cors);
    }
  },
  // Nightly cleanup of expired sessions and throttle buckets.
  async scheduled(_ev, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM throttle WHERE reset_at < ?').bind(now),
    ]);
  },
};

// ---------- helpers ----------
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
async function body(req) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > 16384) fail('Request too large', 413);
  try { const b = await req.json(); return b && typeof b === 'object' ? b : {}; } catch { fail('Invalid JSON'); }
}
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const ipOf = req => req.headers.get('CF-Connecting-IP') || '0.0.0.0';

async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
async function pbkdf2(password, saltHex, iter) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function randomCode(n = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map(x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}
const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 10) fail('Password must be at least 10 characters');
  if (p.length > 200) fail('Password is too long');
}

// Per-IP throttle (fixed window) stored in D1.
async function throttle(env, kind, ip) {
  const [max, windowSec] = THROTTLE[kind];
  const key = `${kind}:${ip}`;
  const t = now();
  const row = await env.DB.prepare('SELECT count, reset_at FROM throttle WHERE key = ?').bind(key).first();
  if (!row || row.reset_at < t) {
    await env.DB.prepare('INSERT OR REPLACE INTO throttle (key, count, reset_at) VALUES (?, 1, ?)').bind(key, t + windowSec * 1000).run();
    return;
  }
  if (row.count >= max) fail('Too many attempts. Try again later.', 429);
  await env.DB.prepare('UPDATE throttle SET count = count + 1 WHERE key = ?').bind(key).run();
}

// ---------- auth ----------
async function createSession(env, req, userId) {
  const raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const t = now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, ua) VALUES (?,?,?,?,?,?)')
    .bind(await sha256Hex(raw), userId, t, t + SESSION_MS, t, clean(req.headers.get('User-Agent'), 200)).run();
  return raw;
}

async function requireUser(req, env, ctx) {
  const auth = req.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer ([A-Za-z0-9_-]{40,50})$/);
  if (!m) fail('Sign in required', 401);
  const th = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    'SELECT s.token_hash, s.expires_at, u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ).bind(th).first();
  const t = now();
  if (!row || row.expires_at < t) {
    if (row) ctx.waitUntil(env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(th).run());
    fail('Session expired — sign in again', 401);
  }
  // Sliding renewal, done off the request path.
  const renew = row.expires_at - t < SESSION_RENEW_MS ? t + SESSION_MS : row.expires_at;
  ctx.waitUntil(env.DB.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').bind(t, renew, th).run());
  return { id: row.id, email: row.email, name: row.name, tokenHash: th };
}

async function signup(req, env) {
  await throttle(env, 'signup', ipOf(req));
  const b = await body(req);
  const email = clean(b.email, 254).toLowerCase();
  const name = clean(b.name, 80);
  if (!validEmail(email)) fail('Enter a valid email');
  if (!name) fail('Enter your name');
  checkPassword(b.password);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) fail('An account with that email already exists', 409);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const id = uid();
  await env.DB.prepare('INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, email, name, await pbkdf2(b.password, salt, PBKDF2_ITER), salt, PBKDF2_ITER, now()).run();
  const token = await createSession(env, req, id);
  return json({ token, user: { id, email, name } }, 201);
}

async function login(req, env) {
  await throttle(env, 'login', ipOf(req));
  const b = await body(req);
  const email = clean(b.email, 254).toLowerCase();
  const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  // Always do a hash so timing doesn't reveal whether the email exists.
  const salt = u ? u.pw_salt : hex(new Uint8Array(16));
  const candidate = await pbkdf2(password, salt, u ? u.pw_iter : PBKDF2_ITER);
  if (!u) fail('Wrong email or password', 401);
  if (u.lock_until > now()) fail('Too many wrong passwords. Try again in 15 minutes.', 429);
  if (!timingSafeEqual(candidate, u.pw_hash)) {
    const fails = u.fails + 1;
    const lock = fails >= LOCK_AFTER ? now() + LOCK_MS : 0;
    await env.DB.prepare('UPDATE users SET fails = ?, lock_until = ? WHERE id = ?').bind(lock ? 0 : fails, lock, u.id).run();
    fail('Wrong email or password', 401);
  }
  if (u.fails || u.lock_until) await env.DB.prepare('UPDATE users SET fails = 0, lock_until = 0 WHERE id = ?').bind(u.id).run();
  const token = await createSession(env, req, u.id);
  return json({ token, user: { id: u.id, email: u.email, name: u.name } });
}

async function changePassword(req, env, user) {
  const b = await body(req);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  const cur = typeof b.current === 'string' ? b.current.slice(0, 200) : '';
  if (!timingSafeEqual(await pbkdf2(cur, u.pw_salt, u.pw_iter), u.pw_hash)) fail('Current password is wrong', 401);
  checkPassword(b.password);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?').bind(await pbkdf2(b.password, salt, PBKDF2_ITER), salt, PBKDF2_ITER, user.id),
    // Sign out every other device.
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, user.tokenHash),
  ]);
  return json({ ok: true });
}

// ---------- players / access ----------
async function roleOn(env, user, playerId) {
  const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(playerId).first();
  if (!p) fail('Player not found', 404);
  if (p.owner_id === user.id) return { player: p, role: 'owner' };
  const a = await env.DB.prepare('SELECT role, team_name FROM player_access WHERE player_id = ? AND user_id = ?').bind(playerId, user.id).first();
  if (!a) fail('Player not found', 404); // don't reveal existence
  return { player: p, role: a.role, teamName: a.team_name };
}
const canLog = role => role === 'owner' || role === 'coach';

function pubPlayer(p, role, extra = {}) {
  const out = { id: p.id, name: p.name, birthYear: p.birth_year, birthMonth: p.birth_month, throws: p.throws, role, ...extra };
  if (role === 'owner') out.shareCode = p.share_code;
  return out;
}

async function listPlayers(env, user, url) {
  const today = isYmd(url.searchParams.get('today') || '') ? url.searchParams.get('today') : todayLocal();
  const rows = (await env.DB.prepare(`
    SELECT p.*, 'owner' AS role, '' AS team_name FROM players p WHERE p.owner_id = ?
    UNION ALL
    SELECT p.*, a.role AS role, a.team_name FROM players p JOIN player_access a ON a.player_id = p.id WHERE a.user_id = ?
    ORDER BY name`).bind(user.id, user.id).all()).results;
  if (!rows.length) return json({ today, players: [] });
  const ids = rows.map(r => r.id);
  const since = addDaysStr(today, -10);
  const outings = (await env.DB.prepare(
    `SELECT player_id, date, pitches, caught, team_name FROM outings WHERE date >= ? AND player_id IN (${ids.map(() => '?').join(',')})`
  ).bind(since, ...ids).all()).results;
  const byPlayer = new Map();
  for (const o of outings) { if (!byPlayer.has(o.player_id)) byPlayer.set(o.player_id, []); byPlayer.get(o.player_id).push(o); }
  const players = rows.map(p => pubPlayer(p, p.role, { teamName: p.team_name, status: computeStatus(p, byPlayer.get(p.id) || [], today) }));
  return json({ today, players });
}
function addDaysStr(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

function parsePlayerFields(b, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) { out.name = clean(b.name, 60); if (!out.name) fail('Enter the player’s name'); }
  if (!partial || b.birthYear !== undefined) {
    const y = Number(b.birthYear), m = Number(b.birthMonth);
    const thisYear = new Date().getUTCFullYear();
    if (!Number.isInteger(y) || y < thisYear - 60 || y > thisYear) fail('Enter a valid birth year');
    if (!Number.isInteger(m) || m < 1 || m > 12) fail('Enter a valid birth month');
    out.birth_year = y; out.birth_month = m;
  }
  if (!partial || b.throws !== undefined) { out.throws = b.throws === 'L' ? 'L' : 'R'; }
  return out;
}

async function createPlayer(req, env, user) {
  const b = await body(req);
  const f = parsePlayerFields(b);
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE owner_id = ?').bind(user.id).first();
  if (c.n >= MAX_PLAYERS) fail('Player limit reached');
  const id = uid();
  let code;
  for (let i = 0; i < 5; i++) {
    code = randomCode();
    if (!(await env.DB.prepare('SELECT 1 FROM players WHERE share_code = ?').bind(code).first())) break;
  }
  const p = { id, owner_id: user.id, ...f, share_code: code, created_at: now() };
  await env.DB.prepare('INSERT INTO players (id, owner_id, name, birth_year, birth_month, throws, share_code, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(p.id, p.owner_id, p.name, p.birth_year, p.birth_month, p.throws, p.share_code, p.created_at).run();
  return json(pubPlayer(p, 'owner', { status: computeStatus(p, [], todayLocal()) }), 201);
}

async function getPlayer(env, user, id, url) {
  const { player, role, teamName } = await roleOn(env, user, id);
  const today = isYmd(url.searchParams.get('today') || '') ? url.searchParams.get('today') : todayLocal();
  const outings = (await env.DB.prepare(
    `SELECT o.id, o.date, o.team_name, o.pitches, o.innings, o.caught, o.note, o.logged_by, o.created_at, u.name AS logged_by_name
     FROM outings o JOIN users u ON u.id = o.logged_by WHERE o.player_id = ? ORDER BY o.date DESC, o.created_at DESC LIMIT 500`
  ).bind(id).all()).results;
  const extra = { teamName, today, status: computeStatus(player, outings, today), outings: outings.map(o => ({ ...o, mine: o.logged_by === user.id })) };
  if (role === 'owner') {
    extra.access = (await env.DB.prepare(
      'SELECT a.user_id, a.role, a.team_name, a.created_at, u.name, u.email FROM player_access a JOIN users u ON u.id = a.user_id WHERE a.player_id = ? ORDER BY a.created_at'
    ).bind(id).all()).results;
  }
  return json(pubPlayer(player, role, extra));
}

async function updatePlayer(req, env, user, id) {
  const { role } = await roleOn(env, user, id);
  if (role !== 'owner') fail('Only the player’s parent can edit this', 403);
  const f = parsePlayerFields(await body(req), true);
  const keys = Object.keys(f);
  if (!keys.length) fail('Nothing to update');
  await env.DB.prepare(`UPDATE players SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map(k => f[k]), id).run();
  return json({ ok: true });
}

async function deletePlayer(env, user, id) {
  const { role } = await roleOn(env, user, id);
  if (role !== 'owner') fail('Only the player’s parent can delete this', 403);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM outings WHERE player_id = ?').bind(id),
    env.DB.prepare('DELETE FROM player_access WHERE player_id = ?').bind(id),
    env.DB.prepare('DELETE FROM players WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function rotateShareCode(env, user, id) {
  const { role } = await roleOn(env, user, id);
  if (role !== 'owner') fail('Only the player’s parent can do this', 403);
  const code = randomCode();
  await env.DB.prepare('UPDATE players SET share_code = ? WHERE id = ?').bind(code, id).run();
  return json({ shareCode: code });
}

// Coach enters the parent's share code to link to a player.
async function linkPlayer(req, env, user) {
  await throttle(env, 'link', ipOf(req));
  const b = await body(req);
  const code = clean(b.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const teamName = clean(b.teamName, 60);
  if (code.length !== 8) fail('Enter the 8-character code from the parent');
  if (!teamName) fail('Enter your team name');
  const p = await env.DB.prepare('SELECT * FROM players WHERE share_code = ?').bind(code).first();
  if (!p) fail('No player matches that code', 404);
  if (p.owner_id === user.id) fail('That’s your own player — you already have full access');
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM player_access WHERE player_id = ?').bind(p.id).first();
  if (n.n >= MAX_COACHES) fail('This player already has the maximum number of coaches');
  await env.DB.prepare(
    'INSERT INTO player_access (player_id, user_id, role, team_name, created_at) VALUES (?,?,?,?,?) ON CONFLICT(player_id, user_id) DO UPDATE SET team_name = excluded.team_name'
  ).bind(p.id, user.id, 'coach', teamName, now()).run();
  return json(pubPlayer(p, 'coach', { teamName }), 201);
}

async function setAccess(req, env, user, id, targetUserId) {
  const { role } = await roleOn(env, user, id);
  if (role !== 'owner') fail('Only the player’s parent can change access', 403);
  const b = await body(req);
  if (!ROLES.includes(b.role)) fail('Bad role');
  const r = await env.DB.prepare('UPDATE player_access SET role = ? WHERE player_id = ? AND user_id = ?').bind(b.role, id, clean(targetUserId, 40)).run();
  if (!r.meta.changes) fail('Not found', 404);
  return json({ ok: true });
}

async function removeAccess(env, user, id, targetUserId) {
  const { role } = await roleOn(env, user, id);
  const target = clean(targetUserId, 40);
  if (role !== 'owner' && target !== user.id) fail('Not allowed', 403); // coaches may only unlink themselves
  await env.DB.prepare('DELETE FROM player_access WHERE player_id = ? AND user_id = ?').bind(id, target).run();
  return json({ ok: true });
}

// ---------- outings ----------
function parseOuting(b, partial = false) {
  const out = {};
  if (!partial || b.date !== undefined) {
    out.date = clean(b.date, 10);
    if (!isYmd(out.date)) fail('Enter a valid date');
    if (out.date > addDaysStr(todayLocal(), 1)) fail('That date is in the future');
  }
  if (!partial || b.pitches !== undefined) {
    const p = Number(b.pitches);
    if (!Number.isInteger(p) || p < 0 || p > 250) fail('Pitches must be 0–250');
    out.pitches = p;
  }
  if (b.innings !== undefined) {
    const i = Number(b.innings);
    if (Number.isNaN(i) || i < 0 || i > 20) fail('Innings must be 0–20');
    out.innings = Math.round(i * 3) / 3;
  }
  if (b.caught !== undefined) out.caught = b.caught ? 1 : 0;
  if (b.teamName !== undefined) out.team_name = clean(b.teamName, 60);
  if (b.note !== undefined) out.note = clean(b.note, 300);
  return out;
}

async function createOuting(req, env, user, id) {
  const { role, teamName } = await roleOn(env, user, id);
  if (!canLog(role)) fail('Viewers can’t log outings', 403);
  const b = await body(req);
  const f = parseOuting(b);
  if (f.team_name === undefined) f.team_name = teamName || '';
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM outings WHERE player_id = ?').bind(id).first();
  if (n.n >= MAX_OUTINGS) fail('Outing limit reached');
  const t = now();
  const oid = uid();
  await env.DB.prepare(
    'INSERT INTO outings (id, player_id, logged_by, date, team_name, pitches, innings, caught, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(oid, id, user.id, f.date, f.team_name, f.pitches, f.innings ?? 0, f.caught ?? 0, f.note ?? '', t, t).run();
  return json({ id: oid }, 201);
}

async function outingAccess(env, user, id, oid) {
  const { role } = await roleOn(env, user, id);
  const o = await env.DB.prepare('SELECT * FROM outings WHERE id = ? AND player_id = ?').bind(clean(oid, 40), id).first();
  if (!o) fail('Outing not found', 404);
  if (role !== 'owner' && o.logged_by !== user.id) fail('You can only change outings you logged', 403);
  return o;
}

async function updateOuting(req, env, user, id, oid) {
  const o = await outingAccess(env, user, id, oid);
  const f = parseOuting(await body(req), true);
  const keys = Object.keys(f);
  if (!keys.length) fail('Nothing to update');
  await env.DB.prepare(`UPDATE outings SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...keys.map(k => f[k]), now(), o.id).run();
  return json({ ok: true });
}

async function deleteOuting(env, user, id, oid) {
  const o = await outingAccess(env, user, id, oid);
  await env.DB.prepare('DELETE FROM outings WHERE id = ?').bind(o.id).run();
  return json({ ok: true });
}

// ---------- router ----------
async function route(req, env, ctx) {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const m = req.method;
  if (parts[0] !== 'api') return json({ ok: true, app: 'Pitch Count Passport API' });
  const [, a, b, c, d] = parts;

  // Public auth routes
  if (a === 'auth' && b === 'signup' && m === 'POST') return signup(req, env);
  if (a === 'auth' && b === 'login' && m === 'POST') return login(req, env);

  const user = await requireUser(req, env, ctx);

  if (a === 'auth') {
    if (b === 'me' && m === 'GET') return json({ user: { id: user.id, email: user.email, name: user.name } });
    if (b === 'logout' && m === 'POST') { await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.tokenHash).run(); return json({ ok: true }); }
    if (b === 'logout-all' && m === 'POST') { await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run(); return json({ ok: true }); }
    if (b === 'password' && m === 'POST') return changePassword(req, env, user);
    if (b === 'sessions' && m === 'GET') {
      const rows = (await env.DB.prepare('SELECT token_hash, created_at, last_seen, ua FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').bind(user.id).all()).results;
      return json({ sessions: rows.map(s => ({ current: s.token_hash === user.tokenHash, createdAt: s.created_at, lastSeen: s.last_seen, ua: s.ua })) });
    }
  }

  if (a === 'link' && m === 'POST') return linkPlayer(req, env, user);

  if (a === 'players') {
    if (!b && m === 'GET') return listPlayers(env, user, url);
    if (!b && m === 'POST') return createPlayer(req, env, user);
    const id = clean(b, 40);
    if (!c && m === 'GET') return getPlayer(env, user, id, url);
    if (!c && m === 'PATCH') return updatePlayer(req, env, user, id);
    if (!c && m === 'DELETE') return deletePlayer(env, user, id);
    if (c === 'share' && m === 'POST') return rotateShareCode(env, user, id);
    if (c === 'access' && d && m === 'PATCH') return setAccess(req, env, user, id, d);
    if (c === 'access' && d && m === 'DELETE') return removeAccess(env, user, id, d);
    if (c === 'outings' && !d && m === 'POST') return createOuting(req, env, user, id);
    if (c === 'outings' && d && m === 'PATCH') return updateOuting(req, env, user, id, d);
    if (c === 'outings' && d && m === 'DELETE') return deleteOuting(env, user, id, d);
  }
  fail('Not found', 404);
}
