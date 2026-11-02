// Pitch Count Passport — arm-load rules engine.
// Shared by the Worker (server-side truth) and the web app (instant UI).
// Based on MLB / USA Baseball Pitch Smart guidelines (mlb.com/pitch-smart).

// Each tier: [maxPitchesInTier, requiredRestDays]. The last tier is open-ended.
const BRACKETS = [
  { min: 0,  max: 8,  daily: 50,  tiers: [[20, 0], [35, 1], [50, 2]] },
  { min: 9,  max: 10, daily: 75,  tiers: [[20, 0], [35, 1], [50, 2], [65, 3], [Infinity, 4]] },
  { min: 11, max: 12, daily: 85,  tiers: [[20, 0], [35, 1], [50, 2], [65, 3], [Infinity, 4]] },
  { min: 13, max: 14, daily: 95,  tiers: [[20, 0], [35, 1], [50, 2], [65, 3], [Infinity, 4]] },
  { min: 15, max: 16, daily: 95,  tiers: [[30, 0], [45, 1], [60, 2], [75, 3], [Infinity, 4]] },
  { min: 17, max: 18, daily: 105, tiers: [[30, 0], [45, 1], [60, 2], [75, 3], [Infinity, 4]] },
  { min: 19, max: 99, daily: 120, tiers: [[30, 0], [45, 1], [60, 2], [80, 3], [105, 4], [Infinity, 5]] },
];

export function bracketFor(age) {
  const a = Math.max(0, Math.min(99, Number(age) || 0));
  return BRACKETS.find(b => a >= b.min && a <= b.max) || BRACKETS[BRACKETS.length - 1];
}

export function restDaysFor(age, pitches) {
  if (!pitches || pitches <= 0) return 0;
  const b = bracketFor(age);
  for (const [limit, rest] of b.tiers) if (pitches <= limit) return rest;
  return b.tiers[b.tiers.length - 1][1];
}

// Age in whole years as of a YYYY-MM-DD date.
export function ageOn(birthYear, birthMonth, ymd) {
  const [y, m] = ymd.split('-').map(Number);
  let age = y - birthYear;
  if (m < birthMonth) age -= 1;
  return Math.max(0, age);
}

// ---- date helpers (all on YYYY-MM-DD strings, no timezone surprises) ----
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d + n);
  return new Date(t).toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  const p = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86400000);
}
export function todayLocal(d = new Date()) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}
export const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/**
 * Compute arm status for a player on a given day.
 * @param {{birth_year:number, birth_month:number}} player
 * @param {Array<{date:string, pitches:number, caught?:number|boolean, team_name?:string}>} outings
 * @param {string} today YYYY-MM-DD
 */
export function computeStatus(player, outings, today) {
  const age = ageOn(player.birth_year, player.birth_month, today);
  const bracket = bracketFor(age);
  const sorted = [...outings].filter(o => o.date <= today).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // Pitches per calendar day (a kid can appear in two games in one day).
  const byDay = new Map();
  for (const o of sorted) byDay.set(o.date, (byDay.get(o.date) || 0) + (o.pitches || 0));

  const todayPitches = byDay.get(today) || 0;
  const reasons = [];
  let clearedOn = today; // first day they may pitch again

  // 1) Required rest from every prior day's total.
  for (const [date, pitches] of byDay) {
    if (date === today) continue;
    const rest = restDaysFor(ageOn(player.birth_year, player.birth_month, date), pitches);
    const eligible = addDays(date, rest + 1);
    if (eligible > clearedOn) {
      clearedOn = eligible;
      reasons.length = 0;
      reasons.push(`${pitches} pitches on ${fmt(date)} → ${rest} day${rest === 1 ? '' : 's'} rest`);
    }
  }

  // 2) Never three consecutive days, regardless of counts.
  const y1 = addDays(today, -1), y2 = addDays(today, -2);
  if (byDay.has(y1) && byDay.has(y2)) {
    const eligible = addDays(today, 1);
    if (eligible > clearedOn) { clearedOn = eligible; reasons.length = 0; }
    reasons.push('Pitched the last two days — no third consecutive day');
  }

  // 3) Daily max already reached today.
  const remainingToday = Math.max(0, bracket.daily - todayPitches);
  let status;
  if (clearedOn > today) status = 'red';
  else if (remainingToday === 0) { status = 'red'; reasons.push(`Hit the ${bracket.daily}-pitch daily max today`); }
  else if (todayPitches > 0 || byDay.has(y1)) {
    status = 'yellow';
    if (todayPitches > 0) reasons.push(`Already threw ${todayPitches} today — ${remainingToday} left before the daily max`);
    if (byDay.has(y1)) reasons.push(`Pitched yesterday (${byDay.get(y1)} pitches) — a short outing is OK, no third day in a row`);
  } else status = 'green';

  // Catching guidance (Pitch Smart: don't catch after 41+ pitches the same day).
  const noCatchToday = todayPitches >= 41;

  // Rolling 7-day load for the dashboard.
  const weekStart = addDays(today, -6);
  let last7 = 0;
  for (const [date, p] of byDay) if (date >= weekStart) last7 += p;

  const last = sorted[0] || null;
  return {
    age, dailyMax: bracket.daily, status, clearedOn, remainingToday, todayPitches,
    noCatchToday, last7, reasons,
    lastOuting: last ? { date: last.date, pitches: last.pitches, team: last.team_name || '' } : null,
    nextThresholds: bracket.tiers.map(([limit, rest]) => ({ upTo: limit === Infinity ? null : limit, rest })),
  };
}

export function fmt(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}
