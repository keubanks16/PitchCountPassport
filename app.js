// Pitch Count Passport — web app. No frameworks, no innerHTML with user data.
import { computeStatus, todayLocal, fmt, addDays, bracketFor, ageOn } from './rules.js';

const API = localStorage.getItem('pcp_api') || 'https://pitchcountpassport.kollinmeubanks.workers.dev';
const TOKEN_KEY = 'pcp_token';

// ---------- tiny DOM helper ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html_unsafe_static') el.innerHTML = v; // only for constant strings
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const $ = s => document.querySelector(s);
const view = $('#view'), titleEl = $('#title'), backBtn = $('#back'), acctBtn = $('#account');
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200); }

// ---------- API ----------
const token = () => localStorage.getItem(TOKEN_KEY);
async function api(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token()) headers.Authorization = 'Bearer ' + token();
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('Can’t reach the server. Check your connection.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token()) { localStorage.removeItem(TOKEN_KEY); state.user = null; go('#/auth'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// ---------- state + routing ----------
const state = { user: null, players: null, today: todayLocal() };
function go(hash) { location.hash = hash; }
window.addEventListener('hashchange', render);
backBtn.addEventListener('click', () => history.length > 1 ? history.back() : go('#/'));
acctBtn.addEventListener('click', () => go('#/account'));

function setChrome({ title, back = false, account = false }) {
  titleEl.textContent = title;
  backBtn.hidden = !back;
  acctBtn.hidden = !account;
}

async function render() {
  const hash = location.hash || '#/';
  if (!token()) return renderAuth();
  if (!state.user) {
    try { state.user = (await api('GET', '/api/auth/me')).user; } catch { return; }
  }
  if (hash.startsWith('#/p/')) return renderPlayer(decodeURIComponent(hash.slice(4).split('/')[0]), hash.endsWith('/live'));
  if (hash === '#/account') return renderAccount();
  if (hash === '#/add') return renderAddPlayer();
  if (hash === '#/link') return renderLink();
  return renderHome();
}

function busy(btn, on) { btn.disabled = on; btn.dataset.label ??= btn.textContent; btn.textContent = on ? 'Working…' : btn.dataset.label; }
function field(label, input) { return h('label', { class: 'field' }, label, input); }

// ---------- auth ----------
function renderAuth() {
  setChrome({ title: 'Pitch Count Passport' });
  let mode = 'login';
  const err = h('div', { class: 'error' });
  const email = h('input', { type: 'email', autocomplete: 'email', inputmode: 'email', required: true, placeholder: 'you@example.com' });
  const name = h('input', { type: 'text', autocomplete: 'name', placeholder: 'Your name' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'At least 10 characters' });
  const nameField = field('Name', name);
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Sign in' });
  const tabs = h('div', { class: 'tabs' },
    h('button', { type: 'button', class: 'on', text: 'Sign in', onclick: e => setMode('login', e.target) }),
    h('button', { type: 'button', text: 'Create account', onclick: e => setMode('signup', e.target) }));
  function setMode(m, btn) {
    mode = m; err.textContent = '';
    nameField.hidden = m === 'login';
    pass.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    submit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    submit.dataset.label = submit.textContent;
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
  }
  nameField.hidden = true;
  const form = h('form', { class: 'card stack', onsubmit: async e => {
    e.preventDefault(); err.textContent = ''; busy(submit, true);
    try {
      const r = await api('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/signup', { email: email.value, password: pass.value, name: name.value });
      localStorage.setItem(TOKEN_KEY, r.token); state.user = r.user; state.players = null; go('#/');
    } catch (ex) { err.textContent = ex.message; } finally { busy(submit, false); }
  } }, tabs, nameField, field('Email', email), field('Password', pass), err, submit);

  view.replaceChildren(
    h('div', { class: 'hero' }, logo(), h('h2', { text: 'Pitch Count Passport' }), h('p', { class: 'muted', text: 'One arm profile per kid. Every coach logs. Nobody overthrows.' })),
    form,
    h('p', { class: 'muted small center', text: 'Parents create the player and share an 8-character code. Coaches enter the code to log pitches for their team. Rest rules follow MLB / USA Baseball Pitch Smart.' }),
  );
}
function logo() { const img = h('img', { class: 'logo', src: 'icon.svg', alt: '' }); return img; }

// ---------- home ----------
async function renderHome() {
  setChrome({ title: 'My Players', account: true });
  view.replaceChildren(h('p', { class: 'muted center', text: 'Loading…' }));
  try { const r = await api('GET', '/api/players?today=' + todayLocal()); state.players = r.players; state.today = r.today; }
  catch (ex) { view.replaceChildren(h('div', { class: 'card error', text: ex.message })); return; }
  const mine = state.players.filter(p => p.role === 'owner');
  const linked = state.players.filter(p => p.role !== 'owner');
  const list = (title, items) => items.length ? [h('h2', { class: 'muted small', text: title }), ...items.map(playerRow)] : [];
  view.replaceChildren(
    ...(!state.players.length ? [h('div', { class: 'card center stack' },
      h('h3', { text: 'Welcome, ' + state.user.name.split(' ')[0] }),
      h('p', { class: 'muted', text: 'Parent? Add your player. Coach? Link a player with the code a parent gave you.' }))] : []),
    ...list('My kids', mine),
    ...list('Players I coach', linked),
    h('div', { class: 'two' },
      h('button', { class: 'btn primary', text: '+ Add my player', onclick: () => go('#/add') }),
      h('button', { class: 'btn', text: 'Link with a code', onclick: () => go('#/link') })),
  );
}
function playerRow(p) {
  const s = p.status;
  const sub = s.status === 'red' ? `Rest until ${fmt(s.clearedOn)}` : s.status === 'yellow' ? `OK today · ${s.remainingToday} pitches left` : `Cleared · max ${s.dailyMax} today`;
  return h('button', { class: 'player', onclick: () => go('#/p/' + encodeURIComponent(p.id)) },
    h('span', { class: 'light ' + s.status }),
    h('span', { class: 'grow' }, h('div', { class: 'name', text: p.name }), h('div', { class: 'sub', text: sub + (p.role !== 'owner' ? ` · ${p.teamName || 'coach'}` : '') })),
    h('span', { class: 'chev', text: '›' }));
}

// ---------- add / link ----------
function renderAddPlayer() {
  setChrome({ title: 'Add Player', back: true });
  const err = h('div', { class: 'error' });
  const name = h('input', { type: 'text', required: true, placeholder: 'First name or nickname', maxlength: 60 });
  const y = new Date().getFullYear();
  const year = h('select', {}, ...Array.from({ length: 20 }, (_, i) => h('option', { value: y - 6 - i, text: y - 6 - i, selected: i === 4 })));
  const month = h('select', {}, ...['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => h('option', { value: i + 1, text: m })));
  const throws = h('select', {}, h('option', { value: 'R', text: 'Right' }), h('option', { value: 'L', text: 'Left' }));
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Create passport' });
  view.replaceChildren(h('form', { class: 'card stack', onsubmit: async e => {
    e.preventDefault(); busy(submit, true); err.textContent = '';
    try { const p = await api('POST', '/api/players', { name: name.value, birthYear: Number(year.value), birthMonth: Number(month.value), throws: throws.value }); state.players = null; location.replace('#/p/' + encodeURIComponent(p.id)); }
    catch (ex) { err.textContent = ex.message; } finally { busy(submit, false); }
  } },
    field('Player name', name),
    h('div', { class: 'two' }, field('Birth year', year), field('Birth month', month)),
    field('Throws', throws),
    h('p', { class: 'muted small', text: 'Birth month + year set the Pitch Smart age bracket (daily max and rest days). Only you can see or change this.' }),
    err, submit));
}

function renderLink() {
  setChrome({ title: 'Link a Player', back: true });
  const err = h('div', { class: 'error' });
  const code = h('input', { type: 'text', required: true, placeholder: 'ABCD2345', maxlength: 9, autocapitalize: 'characters', autocomplete: 'off', class: 'mono', style: 'text-transform:uppercase' });
  const team = h('input', { type: 'text', required: true, placeholder: 'e.g. Stingerz 10U', maxlength: 60 });
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Link player' });
  view.replaceChildren(h('form', { class: 'card stack', onsubmit: async e => {
    e.preventDefault(); busy(submit, true); err.textContent = '';
    try { const p = await api('POST', '/api/link', { code: code.value, teamName: team.value }); state.players = null; toast(`Linked to ${p.name}`); location.replace('#/p/' + encodeURIComponent(p.id)); }
    catch (ex) { err.textContent = ex.message; } finally { busy(submit, false); }
  } },
    h('p', { class: 'muted', text: 'Ask the parent for the player’s 8-character passport code. You’ll be able to log pitches for your team and see their arm status across every team they play for.' }),
    field('Passport code', code), field('Your team name', team), err, submit));
}

// ---------- player ----------
async function renderPlayer(id, live) {
  setChrome({ title: 'Player', back: true });
  view.replaceChildren(h('p', { class: 'muted center', text: 'Loading…' }));
  let p;
  try { p = await api('GET', `/api/players/${encodeURIComponent(id)}?today=${todayLocal()}`); }
  catch (ex) { view.replaceChildren(h('div', { class: 'card error', text: ex.message })); return; }
  titleEl.textContent = p.name;
  if (live) return renderLive(p);
  const s = p.status, owner = p.role === 'owner', canLog = owner || p.role === 'coach';
  const headline = s.status === 'red' ? `Rest — cleared ${fmt(s.clearedOn)}` : s.status === 'yellow' ? 'OK to pitch — watch the count' : 'Cleared to pitch';
  const statusCard = h('div', { class: 'status ' + s.status },
    h('div', { class: 'big', text: headline }),
    s.reasons.length ? h('ul', { class: 'why' }, ...s.reasons.map(r => h('li', { text: r }))) : null,
    s.noCatchToday ? h('ul', { class: 'why' }, h('li', { text: 'Threw 41+ today — should not catch the rest of the day' })) : null,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', { text: s.status === 'red' ? '0' : String(s.remainingToday) }), h('span', { text: 'left today' })),
      h('div', { class: 'stat' }, h('b', { text: String(s.dailyMax) }), h('span', { text: `max · age ${s.age}` })),
      h('div', { class: 'stat' }, h('b', { text: String(s.last7) }), h('span', { text: 'last 7 days' }))));

  const report = buildReport(p);
  const reportCard = h('div', { class: 'card stack' },
    h('h2', { text: 'Pre-game card' }),
    h('pre', { class: 'report', text: report }),
    h('div', { class: 'two' },
      h('button', { class: 'btn sm', text: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(report); toast('Copied'); } catch { toast('Couldn’t copy'); } } }),
      navigator.share ? h('button', { class: 'btn sm', text: 'Share', onclick: () => navigator.share({ text: report }).catch(() => {}) }) : null));

  const actions = canLog ? h('div', { class: 'two' },
    h('button', { class: 'btn primary', text: '▶ Live count', onclick: () => go(`#/p/${encodeURIComponent(p.id)}/live`) }),
    h('button', { class: 'btn', text: '+ Log outing', onclick: () => logForm.hidden = !logForm.hidden })) : null;
  const logForm = canLog ? outingForm(p, null, () => renderPlayer(id)) : null;
  if (logForm) logForm.hidden = true;

  const outings = h('div', { class: 'card' }, h('h2', { text: 'Outings' }),
    p.outings.length ? p.outings.map(o => outingRow(p, o, () => renderPlayer(id))) : h('p', { class: 'muted', text: 'No outings yet.' }));

  const b = bracketFor(s.age);
  const tiers = h('div', { class: 'card' }, h('h2', { text: `Pitch Smart · ages ${b.min}–${b.max === 99 ? '22' : b.max}` }),
    h('div', { class: 'tiers' }, ...b.tiers.map(([lim, rest], i) => h('div', {}, h('b', { text: `${i ? b.tiers[i - 1][0] + 1 : 1}–${lim === Infinity ? '' : lim}`.replace(/–$/, '+') }), `${rest} day${rest === 1 ? '' : 's'} rest`))),
    h('p', { class: 'muted small', text: `Daily max ${b.daily}. Rest days are full calendar days. Never three days in a row.` }));

  view.replaceChildren(...[statusCard, actions, logForm, reportCard, outings, tiers, owner ? ownerPanel(p, id) : coachPanel(p, id)].filter(Boolean));
}

function buildReport(p) {
  const s = p.status, t = todayLocal();
  const lines = [`${p.name} — arm status for ${fmt(t)}`];
  if (s.status === 'red') lines.push(`🔴 DO NOT PITCH. Cleared ${fmt(s.clearedOn)}.`);
  else if (s.status === 'yellow') lines.push(`🟡 OK to pitch. ${s.remainingToday} pitches left today (max ${s.dailyMax}).`);
  else lines.push(`🟢 Cleared. Max ${s.dailyMax} pitches today.`);
  for (const r of s.reasons) lines.push(`• ${r}`);
  if (s.lastOuting) lines.push(`Last outing: ${s.lastOuting.pitches} pitches on ${fmt(s.lastOuting.date)}${s.lastOuting.team ? ' for ' + s.lastOuting.team : ''}.`);
  lines.push(`Last 7 days: ${s.last7} pitches across all teams.`);
  lines.push('— Pitch Count Passport');
  return lines.join('\n');
}

function outingRow(p, o, refresh) {
  const editable = p.role === 'owner' || o.mine;
  const row = h('div', { class: 'outing' },
    h('div', { class: 'p', text: String(o.pitches) }),
    h('div', {}, h('div', { class: 'd', text: fmt(o.date) + (o.innings ? ` · ${o.innings} IP` : '') + (o.caught ? ' · caught' : '') }),
      h('div', { class: 't', text: [o.team_name, 'by ' + o.logged_by_name, o.note].filter(Boolean).join(' · ') })),
    editable ? h('button', { class: 'btn sm ghost', text: 'Edit', onclick: () => { const f = outingForm(p, o, refresh); row.replaceWith(f); } }) : h('span'));
  return row;
}

function outingForm(p, o, done) {
  const err = h('div', { class: 'error' });
  const date = h('input', { type: 'date', required: true, value: o ? o.date : todayLocal(), max: addDays(todayLocal(), 1) });
  const pitches = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 250, required: true, value: o ? o.pitches : '', placeholder: '0' });
  const innings = h('input', { type: 'number', inputmode: 'decimal', min: 0, max: 20, step: '0.1', value: o ? o.innings || '' : '', placeholder: 'optional' });
  const team = h('input', { type: 'text', maxlength: 60, value: o ? o.team_name : (p.teamName || ''), placeholder: 'Team' });
  const caught = h('input', { type: 'checkbox', checked: !!(o && o.caught) });
  const note = h('input', { type: 'text', maxlength: 300, value: o ? o.note : '', placeholder: 'optional' });
  const save = h('button', { class: 'btn primary', type: 'submit', text: o ? 'Save' : 'Log outing' });
  const del = o ? h('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: async () => {
    if (!confirm('Delete this outing?')) return;
    try { await api('DELETE', `/api/players/${encodeURIComponent(p.id)}/outings/${encodeURIComponent(o.id)}`); state.players = null; toast('Deleted'); done(); } catch (ex) { err.textContent = ex.message; }
  } }) : null;
  return h('form', { class: 'card stack', onsubmit: async e => {
    e.preventDefault(); busy(save, true); err.textContent = '';
    const body = { date: date.value, pitches: Number(pitches.value), innings: Number(innings.value || 0), teamName: team.value, caught: caught.checked, note: note.value };
    try {
      if (o) await api('PATCH', `/api/players/${encodeURIComponent(p.id)}/outings/${encodeURIComponent(o.id)}`, body);
      else await api('POST', `/api/players/${encodeURIComponent(p.id)}/outings`, body);
      state.players = null; toast(o ? 'Saved' : 'Outing logged'); done();
    } catch (ex) { err.textContent = ex.message; } finally { busy(save, false); }
  } },
    h('h2', { text: o ? 'Edit outing' : 'Log an outing' }),
    h('div', { class: 'two' }, field('Date', date), field('Pitches', pitches)),
    h('div', { class: 'two' }, field('Innings', innings), field('Team', team)),
    h('label', { class: 'check' }, caught, 'Also caught that day'),
    field('Note', note), err, save, del);
}

// ---------- live counter ----------
function renderLive(p) {
  setChrome({ title: `${p.name} · Live`, back: true });
  const s = p.status;
  const key = 'pcp_live_' + p.id;
  const saved = JSON.parse(localStorage.getItem(key) || 'null');
  let count = saved && saved.date === todayLocal() ? saved.count : 0;
  const startAt = s.todayPitches; // already logged today
  const num = h('div', { class: 'num', text: '0' });
  const maxEl = h('div', { class: 'max' });
  const bar = h('i');
  const tap = h('button', { class: 'tap', text: '+1', onclick: () => { count++; paint(); if (navigator.vibrate) navigator.vibrate(10); } });
  const team = h('input', { type: 'text', maxlength: 60, value: p.teamName || '', placeholder: 'Team' });
  const err = h('div', { class: 'error' });
  function paint() {
    const total = startAt + count;
    const left = s.dailyMax - total;
    num.textContent = String(count);
    maxEl.textContent = startAt ? `${total} today incl. ${startAt} already logged · ${Math.max(0, left)} left of ${s.dailyMax}` : `${Math.max(0, left)} left of ${s.dailyMax} daily max`;
    const pct = Math.min(100, (total / s.dailyMax) * 100);
    bar.style.width = pct + '%';
    const cls = left <= 0 ? 'stop' : left <= 10 ? 'warn' : '';
    bar.className = cls; tap.className = 'tap ' + cls;
    tap.textContent = left <= 0 ? 'MAX' : '+1';
    localStorage.setItem(key, JSON.stringify({ date: todayLocal(), count }));
  }
  paint();
  const save = h('button', { class: 'btn primary', text: 'Save outing', onclick: async () => {
    if (!count) return toast('Nothing to save yet');
    busy(save, true); err.textContent = '';
    try { await api('POST', `/api/players/${encodeURIComponent(p.id)}/outings`, { date: todayLocal(), pitches: count, teamName: team.value }); localStorage.removeItem(key); state.players = null; toast('Saved'); location.replace('#/p/' + encodeURIComponent(p.id)); }
    catch (ex) { err.textContent = ex.message; busy(save, false); }
  } });
  view.replaceChildren(
    ...(s.status === 'red' ? [h('div', { class: 'status red' }, h('div', { class: 'big', text: `Rest day — cleared ${fmt(s.clearedOn)}` }))] : []),
    h('div', { class: 'card counter' },
      num, maxEl, h('div', { class: 'bar' }, bar), tap,
      h('div', { class: 'two' },
        h('button', { class: 'btn sm', text: 'Undo', onclick: () => { if (count) { count--; paint(); } } }),
        h('button', { class: 'btn sm ghost', text: 'Reset', onclick: () => { if (confirm('Reset the count?')) { count = 0; paint(); } } }))),
    h('div', { class: 'card stack' }, field('Team', team), err, save),
    h('p', { class: 'muted small center', text: 'The count stays on this phone until you save it, even if the app closes.' }));
}

// ---------- owner / coach panels ----------
function ownerPanel(p, id) {
  const codeEl = h('div', { class: 'code mono', text: p.shareCode });
  const access = h('div', { class: 'list' },
    p.access.length ? p.access.map(a => h('div', { class: 'row between' },
      h('div', { class: 'grow' }, h('div', { text: a.name }), h('div', { class: 'muted small', text: [a.team_name, a.email].filter(Boolean).join(' · ') })),
      h('select', { onchange: async e => { try { await api('PATCH', `/api/players/${encodeURIComponent(id)}/access/${encodeURIComponent(a.user_id)}`, { role: e.target.value }); toast('Updated'); } catch (ex) { toast(ex.message); } } },
        h('option', { value: 'coach', text: 'Coach', selected: a.role === 'coach' }), h('option', { value: 'viewer', text: 'View only', selected: a.role === 'viewer' })),
      h('button', { class: 'btn sm danger', text: 'Remove', onclick: async () => { if (!confirm(`Remove ${a.name}?`)) return; try { await api('DELETE', `/api/players/${encodeURIComponent(id)}/access/${encodeURIComponent(a.user_id)}`); toast('Removed'); renderPlayer(id); } catch (ex) { toast(ex.message); } } })))
    : h('p', { class: 'muted', text: 'No coaches linked yet. Give a coach the code above.' }));
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', { text: 'Passport code' }), codeEl,
      h('p', { class: 'muted small', text: 'Give this to a coach so they can log pitches. Anyone with the code can link, so only share it with coaches you trust. Make a new one any time — the old one stops working immediately.' }),
      h('div', { class: 'two' },
        h('button', { class: 'btn sm', text: 'Copy code', onclick: async () => { try { await navigator.clipboard.writeText(p.shareCode); toast('Copied'); } catch { toast('Couldn’t copy'); } } }),
        h('button', { class: 'btn sm ghost', text: 'New code', onclick: async () => { if (!confirm('Replace the code? Coaches already linked stay linked.')) return; try { const r = await api('POST', `/api/players/${encodeURIComponent(id)}/share`); p.shareCode = r.shareCode; codeEl.textContent = r.shareCode; toast('New code ready'); } catch (ex) { toast(ex.message); } } }))),
    h('div', { class: 'card' }, h('h2', { text: 'Coaches & viewers' }), access),
    h('div', { class: 'card stack' }, h('h2', { text: 'Player' }),
      h('p', { class: 'muted small', text: `Born ${p.birthMonth}/${p.birthYear} · throws ${p.throws} · Pitch Smart age ${ageOn(p.birthYear, p.birthMonth, todayLocal())}` }),
      h('button', { class: 'btn sm', text: 'Edit player', onclick: () => editPlayer(p, id) }),
      h('button', { class: 'btn sm danger', text: 'Delete player & all outings', onclick: async () => { if (!confirm(`Delete ${p.name} and every outing? This can’t be undone.`)) return; try { await api('DELETE', `/api/players/${encodeURIComponent(id)}`); state.players = null; toast('Deleted'); go('#/'); } catch (ex) { toast(ex.message); } } })));
}
function editPlayer(p, id) {
  const name = h('input', { type: 'text', required: true, value: p.name, maxlength: 60 });
  const year = h('input', { type: 'number', required: true, value: p.birthYear, min: 1990, max: new Date().getFullYear() });
  const month = h('input', { type: 'number', required: true, value: p.birthMonth, min: 1, max: 12 });
  const throws = h('select', {}, h('option', { value: 'R', text: 'Right', selected: p.throws === 'R' }), h('option', { value: 'L', text: 'Left', selected: p.throws === 'L' }));
  const err = h('div', { class: 'error' });
  const save = h('button', { class: 'btn primary', type: 'submit', text: 'Save' });
  view.replaceChildren(h('form', { class: 'card stack', onsubmit: async e => {
    e.preventDefault(); busy(save, true);
    try { await api('PATCH', `/api/players/${encodeURIComponent(id)}`, { name: name.value, birthYear: Number(year.value), birthMonth: Number(month.value), throws: throws.value }); state.players = null; toast('Saved'); renderPlayer(id); }
    catch (ex) { err.textContent = ex.message; busy(save, false); }
  } }, h('h2', { text: 'Edit player' }), field('Name', name), h('div', { class: 'two' }, field('Birth year', year), field('Birth month (1–12)', month)), field('Throws', throws), err, save,
    h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => renderPlayer(id) })));
}
function coachPanel(p, id) {
  return h('div', { class: 'card stack' }, h('h2', { text: 'Your access' }),
    h('p', { class: 'muted small', text: `You’re linked as ${p.role === 'coach' ? 'a coach' : 'a viewer'}${p.teamName ? ' for ' + p.teamName : ''}. The parent controls this link.` }),
    h('button', { class: 'btn sm danger', text: 'Unlink me from this player', onclick: async () => { if (!confirm('Unlink?')) return; try { await api('DELETE', `/api/players/${encodeURIComponent(id)}/access/${encodeURIComponent(state.user.id)}`); state.players = null; go('#/'); } catch (ex) { toast(ex.message); } } }));
}

// ---------- account ----------
async function renderAccount() {
  setChrome({ title: 'Account', back: true });
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
  const err = h('div', { class: 'error' });
  const save = h('button', { class: 'btn primary', type: 'submit', text: 'Change password' });
  let sessions = [];
  try { sessions = (await api('GET', '/api/auth/sessions')).sessions; } catch {}
  view.replaceChildren(
    h('div', { class: 'card' }, h('h3', { text: state.user.name }), h('div', { class: 'muted', text: state.user.email })),
    h('form', { class: 'card stack', onsubmit: async e => {
      e.preventDefault(); busy(save, true); err.textContent = '';
      try { await api('POST', '/api/auth/password', { current: cur.value, password: nw.value }); toast('Password changed — other devices signed out'); cur.value = nw.value = ''; }
      catch (ex) { err.textContent = ex.message; } finally { busy(save, false); }
    } }, h('h2', { text: 'Password' }), field('Current password', cur), field('New password (10+ characters)', nw), err, save),
    h('div', { class: 'card' }, h('h2', { text: `Signed-in devices (${sessions.length})` }),
      h('div', { class: 'list' }, ...sessions.map(s => h('div', {}, h('div', { text: (s.current ? 'This device · ' : '') + uaLabel(s.ua) }), h('div', { class: 'muted small', text: 'Last used ' + new Date(s.lastSeen).toLocaleString() }))))),
    h('div', { class: 'two' },
      h('button', { class: 'btn', text: 'Sign out', onclick: async () => { try { await api('POST', '/api/auth/logout'); } catch {} localStorage.removeItem(TOKEN_KEY); state.user = null; state.players = null; go('#/'); } }),
      h('button', { class: 'btn danger', text: 'Sign out everywhere', onclick: async () => { if (!confirm('Sign out on every device?')) return; try { await api('POST', '/api/auth/logout-all'); } catch {} localStorage.removeItem(TOKEN_KEY); state.user = null; state.players = null; go('#/'); } })),
    h('p', { class: 'muted small center', text: 'Pitch Count Passport stores only your name, email, your players’ names and birth month/year, and pitch logs. Passwords are hashed and never stored in plain text.' }),
  );
}
function uaLabel(ua) {
  if (/iPhone/.test(ua)) return 'iPhone'; if (/iPad/.test(ua)) return 'iPad'; if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows'; if (/Mac/.test(ua)) return 'Mac'; return 'Browser';
}

// ---------- boot ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
