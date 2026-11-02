import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../src/index.js';
import { makeDB } from './d1shim.js';
import { computeStatus, restDaysFor, todayLocal, addDays } from '../../rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const env = { DB: makeDB(join(here, '..', 'schema.sql')) };
const ctx = { waitUntil: p => p && p.catch?.(() => {}) };
const ORIGIN = 'https://keubanks16.github.io';

async function api(method, path, body, token, ip = '1.2.3.4') {
  const headers = { Origin: ORIGIN, 'CF-Connecting-IP': ip };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await worker.fetch(new Request('https://x.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

let parent, coach, player;

test('rules: Pitch Smart rest tiers', () => {
  assert.equal(restDaysFor(10, 20), 0);
  assert.equal(restDaysFor(10, 21), 1);
  assert.equal(restDaysFor(10, 50), 2);
  assert.equal(restDaysFor(10, 66), 4);
  assert.equal(restDaysFor(8, 50), 2);
  assert.equal(restDaysFor(16, 30), 0);
  assert.equal(restDaysFor(16, 76), 4);
  assert.equal(restDaysFor(20, 106), 5);
});

test('rules: status engine', () => {
  const today = '2026-11-02';
  const p = { birth_year: 2016, birth_month: 5 }; // age 10
  assert.equal(computeStatus(p, [], today).status, 'green');
  // 62 pitches 2 days ago → 3 days rest → cleared on the 4th day after
  let s = computeStatus(p, [{ date: '2026-10-31', pitches: 62 }], today);
  assert.equal(s.status, 'red');
  assert.equal(s.clearedOn, '2026-11-04');
  // 15 pitches yesterday → 0 rest → yellow (pitched yesterday)
  s = computeStatus(p, [{ date: '2026-11-01', pitches: 15 }], today);
  assert.equal(s.status, 'yellow');
  // pitched the last two days (small counts) → red for the third day
  s = computeStatus(p, [{ date: '2026-11-01', pitches: 10 }, { date: '2026-10-31', pitches: 10 }], today);
  assert.equal(s.status, 'red');
  assert.equal(s.clearedOn, '2026-11-03');
  // two games same day add up
  s = computeStatus(p, [{ date: '2026-11-01', pitches: 30 }, { date: '2026-11-01', pitches: 25 }], today);
  assert.equal(s.status, 'red'); // 55 → 3 days rest
  // hit daily max today
  s = computeStatus(p, [{ date: today, pitches: 75 }], today);
  assert.equal(s.status, 'red');
  assert.equal(s.remainingToday, 0);
  s = computeStatus(p, [{ date: today, pitches: 45 }], today);
  assert.equal(s.status, 'yellow');
  assert.equal(s.noCatchToday, true);
  assert.equal(s.remainingToday, 30);
});

test('signup validation + account creation', async () => {
  let r = await api('POST', '/api/auth/signup', { email: 'bad', name: 'x', password: 'short' });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/auth/signup', { email: 'Parent@Example.com', name: 'Pat Parent', password: 'correct horse battery' });
  assert.equal(r.status, 201);
  assert.ok(r.body.token.length >= 40);
  parent = r.body.token;
  r = await api('POST', '/api/auth/signup', { email: 'parent@example.com', name: 'Dup', password: 'correct horse battery' });
  assert.equal(r.status, 409);
  r = await api('POST', '/api/auth/signup', { email: 'coach@example.com', name: 'Cody Coach', password: 'another good password' }, null, '9.9.9.9');
  assert.equal(r.status, 201);
  coach = r.body.token;
  // password never leaves the server in any form
  const u = env.DB.raw.prepare('SELECT * FROM users').all();
  for (const row of u) assert.ok(!JSON.stringify(row).includes('correct horse'));
});

test('login, wrong password, lockout', async () => {
  let r = await api('POST', '/api/auth/login', { email: 'parent@example.com', password: 'wrong password!' });
  assert.equal(r.status, 401);
  r = await api('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'wrong password!' });
  assert.equal(r.status, 401);
  for (let i = 0; i < 4; i++) await api('POST', '/api/auth/login', { email: 'parent@example.com', password: 'wrong password!' });
  r = await api('POST', '/api/auth/login', { email: 'parent@example.com', password: 'correct horse battery' });
  assert.equal(r.status, 429, 'locked after 5 fails even with the right password');
  env.DB.raw.prepare('UPDATE users SET lock_until = 0').run();
  r = await api('POST', '/api/auth/login', { email: 'parent@example.com', password: 'correct horse battery' });
  assert.equal(r.status, 200);
});

test('auth required + bad tokens rejected', async () => {
  assert.equal((await api('GET', '/api/players')).status, 401);
  assert.equal((await api('GET', '/api/players', null, 'A'.repeat(43))).status, 401);
  assert.equal((await api('GET', '/api/auth/me', null, parent)).status, 200);
});

test('parent creates player, coach links with code', async () => {
  let r = await api('POST', '/api/players', { name: 'MJ', birthYear: 2016, birthMonth: 5, throws: 'R' }, parent);
  assert.equal(r.status, 201);
  player = r.body;
  assert.equal(player.shareCode.length, 8);
  assert.equal(player.status.status, 'green');
  assert.equal(player.status.dailyMax, 75);

  // coach can't see it yet
  r = await api('GET', '/api/players/' + player.id, null, coach);
  assert.equal(r.status, 404);
  // bad code
  r = await api('POST', '/api/link', { code: 'ZZZZZZZZ', teamName: 'Stingerz' }, coach);
  assert.equal(r.status, 404);
  // owner linking themselves is rejected
  r = await api('POST', '/api/link', { code: player.shareCode, teamName: 'Stingerz' }, parent);
  assert.equal(r.status, 400);
  // good link
  r = await api('POST', '/api/link', { code: player.shareCode.toLowerCase(), teamName: 'Stingerz 10U' }, coach);
  assert.equal(r.status, 201);
  assert.equal(r.body.role, 'coach');
  assert.equal(r.body.shareCode, undefined, 'coach never sees the share code');
  r = await api('GET', '/api/players/' + player.id, null, coach);
  assert.equal(r.status, 200);
  assert.equal(r.body.access, undefined, 'coach never sees the access list');
});

test('outings: coach logs, cross-team load adds up, viewer blocked', async () => {
  const today = todayLocal();
  let r = await api('POST', `/api/players/${player.id}/outings`, { date: addDays(today, -1), pitches: 40, innings: 2.333 }, coach);
  assert.equal(r.status, 201);
  // parent logs for a different team the day before
  r = await api('POST', `/api/players/${player.id}/outings`, { date: addDays(today, -2), pitches: 30, teamName: 'Rec League' }, parent);
  assert.equal(r.status, 201);
  r = await api('GET', '/api/players/' + player.id, null, parent);
  assert.equal(r.body.outings.length, 2);
  assert.equal(r.body.outings[0].team_name, 'Stingerz 10U', 'coach outing defaults to their team name');
  assert.equal(r.body.status.status, 'red'); // 40 pitches yesterday → 2 days rest
  assert.equal(r.body.status.clearedOn, addDays(today, 2));
  assert.ok(r.body.access.length === 1 && r.body.access[0].email === 'coach@example.com');

  // invalid outing data
  assert.equal((await api('POST', `/api/players/${player.id}/outings`, { date: 'nope', pitches: 10 }, coach)).status, 400);
  assert.equal((await api('POST', `/api/players/${player.id}/outings`, { date: today, pitches: 999 }, coach)).status, 400);
  assert.equal((await api('POST', `/api/players/${player.id}/outings`, { date: addDays(today, 5), pitches: 9 }, coach)).status, 400);

  // coach can edit their own outing but not the parent's
  const mine = r.body.outings.find(o => o.team_name === 'Stingerz 10U');
  const theirs = r.body.outings.find(o => o.team_name === 'Rec League');
  assert.equal((await api('PATCH', `/api/players/${player.id}/outings/${mine.id}`, { pitches: 41 }, coach)).status, 200);
  assert.equal((await api('PATCH', `/api/players/${player.id}/outings/${theirs.id}`, { pitches: 1 }, coach)).status, 403);
  assert.equal((await api('DELETE', `/api/players/${player.id}/outings/${theirs.id}`, null, coach)).status, 403);

  // demote coach to viewer → can read, can't log
  r = await api('GET', '/api/players/' + player.id, null, parent);
  const coachId = r.body.access[0].user_id;
  assert.equal((await api('PATCH', `/api/players/${player.id}/access/${coachId}`, { role: 'viewer' }, parent)).status, 200);
  assert.equal((await api('POST', `/api/players/${player.id}/outings`, { date: today, pitches: 5 }, coach)).status, 403);
  assert.equal((await api('GET', '/api/players/' + player.id, null, coach)).status, 200);
  // coach can't change access; can unlink self
  assert.equal((await api('PATCH', `/api/players/${player.id}/access/${coachId}`, { role: 'coach' }, coach)).status, 403);
  assert.equal((await api('DELETE', `/api/players/${player.id}/access/${coachId}`, null, coach)).status, 200);
  assert.equal((await api('GET', '/api/players/' + player.id, null, coach)).status, 404);
});

test('share code rotation invalidates old code', async () => {
  const old = player.shareCode;
  const r = await api('POST', `/api/players/${player.id}/share`, null, parent);
  assert.equal(r.status, 200);
  assert.notEqual(r.body.shareCode, old);
  assert.equal((await api('POST', '/api/link', { code: old, teamName: 'X' }, coach)).status, 404);
  assert.equal((await api('POST', `/api/players/${player.id}/share`, null, coach)).status, 404);
});

test('password change signs out other sessions', async () => {
  const other = (await api('POST', '/api/auth/login', { email: 'parent@example.com', password: 'correct horse battery' })).body.token;
  assert.equal((await api('GET', '/api/auth/me', null, other)).status, 200);
  let r = await api('POST', '/api/auth/password', { current: 'wrong', password: 'a brand new passphrase' }, parent);
  assert.equal(r.status, 401);
  r = await api('POST', '/api/auth/password', { current: 'correct horse battery', password: 'a brand new passphrase' }, parent);
  assert.equal(r.status, 200);
  assert.equal((await api('GET', '/api/auth/me', null, other)).status, 401);
  assert.equal((await api('GET', '/api/auth/me', null, parent)).status, 200);
  assert.equal((await api('POST', '/api/auth/logout', null, parent)).status, 200);
  assert.equal((await api('GET', '/api/auth/me', null, parent)).status, 401);
});

test('CORS: unknown origin does not get reflected', async () => {
  const res = await worker.fetch(new Request('https://x.test/api/auth/me', { headers: { Origin: 'https://evil.example' } }), env, ctx);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('signup throttle per IP', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await api('POST', '/api/auth/signup', { email: `t${i}@example.com`, name: 'T', password: 'a decent password' }, null, '5.5.5.5');
  assert.equal(last.status, 429);
});
