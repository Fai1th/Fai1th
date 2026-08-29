#!/usr/bin/env node
/**
 * Generates profile-ui.svg: a real, animated GitHub contribution graph
 * in the monochrome terminal theme used across this profile.
 *
 * Data sources, in order of preference:
 *   1. GitHub GraphQL API  (needs GH_TOKEN / GITHUB_TOKEN, exact per-day counts)
 *   2. github.com/users/<login>/contributions  (public, no auth, levels + counts)
 *
 * Usage:
 *   node scripts/generate-contribution-graph.mjs
 *   node scripts/generate-contribution-graph.mjs --user Fai1th --out profile-ui.svg
 *   node scripts/generate-contribution-graph.mjs --source html
 */

import { writeFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';

const UA = 'Fai1th-profile-graph (+https://github.com/Fai1th/Fai1th)';
const DAY_MS = 86400000;

/* ------------------------------------------------------------------ args -- */

function parseArgs(list) {
  const out = { user: 'Fai1th', out: 'profile-ui.svg', source: 'auto' };
  for (let i = 0; i < list.length; i++) {
    const [flag, inline] = list[i].split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : list[++i]);
    if (flag === '--user') out.user = value();
    else if (flag === '--out') out.out = value();
    else if (flag === '--source') out.source = value();
    else if (flag === '--help' || flag === '-h') out.help = true;
  }
  return out;
}

/* ------------------------------------------------------------------ data -- */

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

async function fetchFromGraphql(user, token) {
  const query =
    'query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{' +
    'totalContributions weeks{contributionDays{date contributionCount}}}}}}';

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({ query, variables: { login: user } }),
  });

  if (!res.ok) throw new Error(`GraphQL API returned ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors[0].message}`);

  const calendar = body.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) throw new Error(`no contribution calendar for user "${user}"`);

  const days = calendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount }));

  return { days: withLevels(days), total: calendar.totalContributions, source: 'graphql' };
}

async function fetchFromHtml(user) {
  const res = await fetch(`https://github.com/users/${encodeURIComponent(user)}/contributions`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`contributions page returned ${res.status} ${res.statusText}`);
  const html = await res.text();

  // Exact counts live in the screen-reader tooltips, keyed by cell id.
  const counts = new Map();
  const tipRe = /<tool-tip[^>]*\sfor="(contribution-day-component-[\d-]+)"[^>]*>([^<]*)<\/tool-tip>/g;
  for (const m of html.matchAll(tipRe)) {
    const text = decode(m[2]);
    const n = /^no contributions/i.test(text)
      ? 0
      : Number((text.match(/^([\d,]+)\s+contribution/i)?.[1] ?? '0').replace(/,/g, ''));
    counts.set(m[1], n);
  }

  const days = [];
  const cellRe = /<td\b([^>]*\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*)>/g;
  for (const m of html.matchAll(cellRe)) {
    const attrs = m[1];
    if (!attrs.includes('ContributionCalendar-day')) continue;
    const id = attrs.match(/\sid="([^"]+)"/)?.[1] ?? '';
    const level = Number(attrs.match(/data-level="(\d)"/)?.[1] ?? 0);
    days.push({ date: m[2], count: counts.get(id) ?? 0, level });
  }

  if (!days.length) throw new Error(`no contribution cells found for user "${user}"`);

  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, total: days.reduce((n, d) => n + d.count, 0), source: 'html' };
}

/** GitHub-ish bucketing: quartiles over the non-empty days. */
function withLevels(days) {
  const active = days
    .map((d) => d.count)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const at = (p) => (active.length ? active[Math.min(active.length - 1, Math.floor(active.length * p))] : 1);
  const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)];
  return days.map((d) => ({
    ...d,
    level: d.count === 0 ? 0 : d.count <= q1 ? 1 : d.count <= q2 ? 2 : d.count <= q3 ? 3 : 4,
  }));
}

async function loadCalendar({ user, source }) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (source !== 'html' && token) {
    try {
      return await fetchFromGraphql(user, token);
    } catch (err) {
      if (source === 'graphql') throw err;
      console.warn(`! GraphQL failed (${err.message}); falling back to the public page`);
    }
  }
  if (source === 'graphql') throw new Error('--source graphql needs GH_TOKEN or GITHUB_TOKEN');
  return fetchFromHtml(user);
}

/* ----------------------------------------------------------------- stats -- */

const utc = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pretty = (iso) => {
  const d = new Date(utc(iso));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const shortDate = (iso) => {
  const d = new Date(utc(iso));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

function computeStats(days) {
  let longest = 0;
  let run = 0;
  let best = days[0];

  for (const day of days) {
    run = day.count > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
    if (day.count > best.count) best = day;
  }

  // A quiet day today shouldn't break a streak that is still alive.
  let i = days.length - 1;
  if (days[i]?.count === 0) i--;
  let current = 0;
  while (i >= 0 && days[i].count > 0) {
    current++;
    i--;
  }

  return { longest, current, best, activeDays: days.filter((d) => d.count > 0).length };
}

/** Lay the flat day list out on the 7-row calendar grid. */
function toGrid(days) {
  const first = days[0];
  const originWeekday = new Date(utc(first.date)).getUTCDay();
  const cells = days.map((day) => {
    const offset = Math.round((utc(day.date) - utc(first.date)) / DAY_MS) + originWeekday;
    return { ...day, week: Math.floor(offset / 7), row: offset % 7 };
  });
  const weekCount = cells[cells.length - 1].week + 1;

  const weeks = Array.from({ length: weekCount }, () => []);
  for (const cell of cells) weeks[cell.week].push(cell);

  return { cells, weeks, weekCount };
}

/* ---------------------------------------------------------------- render -- */

const round = (n) => Math.round(n * 100) / 100;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function smoothPath(pts, minY, maxY) {
  if (pts.length < 2) return '';
  const clamp = (y) => Math.min(maxY, Math.max(minY, y));
  let d = `M${round(pts[0][0])} ${round(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clamp(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clamp(p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`;
  }
  return d;
}

const polyLength = (pts) =>
  pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

function render({ user, days, total, stats, grid, generatedAt }) {
  const W = 1200;
  const H = 460;
  const PAD = 52;
  const CELL = 15;
  const PITCH = 20;
  const GUTTER = 42;

  const { weeks, weekCount } = grid;
  const gridW = weekCount * PITCH - (PITCH - CELL);
  const gridX = Math.round((W - (GUTTER + gridW)) / 2) + GUTTER;
  const gridY = 134;
  const gridH = 7 * PITCH - (PITCH - CELL);

  const first = days[0];
  const last = days[days.length - 1];

  /* month ruler ---------------------------------------------------------- */
  const months = [];
  let lastMonth = -1;
  let lastCol = -9;
  weeks.forEach((week, col) => {
    const month = new Date(utc(week[0].date)).getUTCMonth();
    if (month === lastMonth) return;
    lastMonth = month;
    if (col - lastCol < 3 || col > weekCount - 3) return;
    months.push({ label: MONTHS[month], x: gridX + col * PITCH });
    lastCol = col;
  });

  /* cells ---------------------------------------------------------------- */
  const columns = weeks
    .map((week, col) => {
      const rects = week
        .map((cell) => {
          const rect =
            `<rect class="c l${cell.level}" x="${gridX + col * PITCH}" y="${gridY + cell.row * PITCH}" ` +
            `width="${CELL}" height="${CELL}" rx="3"`;
          // Only the days that actually say something get a hover label; 350 empty
          // <title> nodes would triple the file for nothing.
          if (cell.count === 0) return `${rect}/>`;
          const label = `${cell.count} contribution${cell.count === 1 ? '' : 's'} on ${pretty(cell.date)}`;
          return `${rect}><title>${esc(label)}</title></rect>`;
        })
        .join('');
      return `<g class="wk w${col}">${rects}</g>`;
    })
    .join('\n    ');

  const weekDelays = weeks.map((_, col) => `.w${col}{animation-delay:${col * 17}ms}`).join('');

  /* today marker --------------------------------------------------------- */
  const todayCell = grid.cells[grid.cells.length - 1];
  const todayRing =
    `<rect class="today" x="${gridX + todayCell.week * PITCH - 1}" y="${gridY + todayCell.row * PITCH - 1}" ` +
    `width="${CELL + 2}" height="${CELL + 2}" rx="4"/>`;

  /* weekly trend --------------------------------------------------------- */
  const weekly = weeks.map((week) => week.reduce((n, d) => n + d.count, 0));
  const peakWeek = weekly.reduce((best, n, i) => (n > weekly[best] ? i : best), 0);
  const peak = Math.max(1, ...weekly);
  const trendTop = 356;
  const trendBase = 424;
  const trendFloor = trendBase - 8; // quiet weeks rest above the axis, not on it
  const points = weekly.map((n, col) => [
    gridX + col * PITCH + CELL / 2,
    trendFloor - (n / peak) * (trendFloor - trendTop),
  ]);
  const halfY = round((trendFloor + trendTop) / 2);
  const trendPath = smoothPath(points, trendTop, trendFloor);
  const trendLen = Math.ceil(polyLength(points) * 1.15) || 1;
  const areaPath = `${trendPath} L${round(points[points.length - 1][0])} ${trendBase} L${round(
    points[0][0],
  )} ${trendBase} Z`;

  /* text ----------------------------------------------------------------- */
  const heading = `${user}'s Contribution Graph`;
  const subtitle = `${total.toLocaleString('en-US')} contributions · ${pretty(first.date)} → ${pretty(
    last.date,
  )}`;
  const legendX = W - PAD - 145;

  const statCells = [
    ['TOTAL', total.toLocaleString('en-US')],
    ['ACTIVE', `${stats.activeDays}d`],
    ['STREAK', `${stats.current}d`],
    ['LONGEST', `${stats.longest}d`],
    ['BEST', `${stats.best.count} · ${shortDate(stats.best.date)}`],
  ];
  const statLine = statCells
    .map(
      ([k, v], i) =>
        `${i ? '<tspan class="dim">   ·   </tspan>' : ''}<tspan class="dim">${k} </tspan><tspan class="white">${esc(
          v,
        )}</tspan>`,
    )
    .join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="graph-title graph-desc">
  <title id="graph-title">${esc(heading)}</title>
  <desc id="graph-desc">${esc(
    subtitle,
  )}. Longest streak ${stats.longest} days, best day ${stats.best.count} contributions on ${pretty(
    stats.best.date,
  )}.</desc>

  <defs>
    <pattern id="grid-lines" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M42 0H0V42" stroke="#ffffff" stroke-opacity="0.035"/>
    </pattern>
    <linearGradient id="trend-fade" x1="0" y1="${trendTop}" x2="0" y2="${trendBase}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="sweep-fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.13"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="grid-clip">
      <rect x="${gridX}" y="${gridY}" width="${gridW}" height="${gridH}"/>
    </clipPath>

    <style>
      .bg { fill: #000000; }
      .frame { fill: none; stroke: #ffffff; stroke-opacity: 0.14; }
      .rule { stroke: #ffffff; stroke-opacity: 0.10; }
      .guide { stroke: #ffffff; stroke-opacity: 0.12; stroke-dasharray: 3 6; }
      .white { fill: #ffffff; }
      .muted { fill: #a8a8a8; }
      .dim { fill: #5f5f5f; }

      .h1 { font: 700 20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .sub { font: 600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .micro { font: 600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

      .c { shape-rendering: geometricPrecision; fill: #ffffff; stroke: #ffffff; stroke-opacity: 0.07; }
      .l0 { fill-opacity: 0.085; }
      .l1 { fill-opacity: 0.28; }
      .l2 { fill-opacity: 0.5; }
      .l3 { fill-opacity: 0.74; }
      .l4 { fill-opacity: 1; }

      .wk {
        transform-box: fill-box;
        transform-origin: 50% 50%;
        animation: rise 0.5s cubic-bezier(0.22, 0.85, 0.28, 1) both;
      }
      ${weekDelays}

      .today {
        fill: none;
        stroke: #ffffff;
        stroke-width: 1.5;
        transform-box: fill-box;
        transform-origin: 50% 50%;
        animation: ring 2.6s ease-out 1.9s infinite;
      }
      .sweep { animation: sweep 5.4s cubic-bezier(0.4, 0, 0.6, 1) 1.6s infinite; }

      .trend {
        fill: none;
        stroke: #ffffff;
        stroke-width: 2.5;
        stroke-linecap: round;
        stroke-linejoin: round;
        animation: draw 2.2s ease-out 0.5s both;
      }
      .trend-area { fill: url(#trend-fade); animation: fade-in 1.1s ease-out 1.5s both; }
      .peak { fill: #ffffff; animation: fade-in 0.6s ease-out 2.4s both, pulse 2.8s ease-in-out 3s infinite; }
      .caret { fill: #ffffff; animation: blink 1.06s steps(1, end) infinite; }

      @keyframes rise {
        from { opacity: 0; transform: scale(0.68); }
        to { opacity: 1; transform: scale(1); }
      }
      @keyframes ring {
        0% { opacity: 0.85; transform: scale(1); }
        70%, 100% { opacity: 0; transform: scale(2.2); }
      }
      @keyframes sweep {
        from { transform: translateX(0); }
        to { transform: translateX(${gridW + 260}px); }
      }
      @keyframes draw {
        from { stroke-dasharray: ${trendLen}; stroke-dashoffset: ${trendLen}; }
        to { stroke-dasharray: ${trendLen}; stroke-dashoffset: 0; }
      }
      @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
      @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }

      @media (prefers-reduced-motion: reduce) {
        .wk, .today, .trend, .trend-area, .peak, .caret { animation: none; }
        .sweep { animation: none; opacity: 0; }
      }
    </style>
  </defs>

  <rect class="bg" width="${W}" height="${H}" rx="14"/>
  <rect width="${W}" height="${H}" rx="14" fill="url(#grid-lines)"/>
  <rect class="frame" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="13.5"/>

  <text x="${W / 2}" y="48" text-anchor="middle" class="h1 white">${esc(
    heading,
  )}<tspan class="caret">█</tspan></text>
  <text x="${W / 2}" y="72" text-anchor="middle" class="sub muted">${esc(subtitle)}</text>
  <path class="rule" d="M${PAD} 92.5H${W - PAD}"/>

  <g class="micro dim">
    ${months.map((m) => `<text x="${m.x}" y="122">${m.label}</text>`).join('\n    ')}
  </g>
  <g class="micro dim" text-anchor="end">
    <text x="${gridX - 12}" y="${gridY + PITCH + 11.5}">Mon</text>
    <text x="${gridX - 12}" y="${gridY + 3 * PITCH + 11.5}">Wed</text>
    <text x="${gridX - 12}" y="${gridY + 5 * PITCH + 11.5}">Fri</text>
  </g>

  <g class="cells">
    ${columns}
  </g>
  ${todayRing}
  <g clip-path="url(#grid-clip)">
    <rect class="sweep" x="${gridX - 260}" y="${gridY}" width="260" height="${gridH}" fill="url(#sweep-fade)"/>
  </g>

  <text x="${PAD}" y="301" class="micro">${statLine}</text>
  <g transform="translate(${legendX} 292)">
    <text x="0" y="9" class="micro dim">LESS</text>
    ${[0, 1, 2, 3, 4]
      .map((l) => `<rect class="c l${l}" x="${37 + l * 15}" y="0" width="11" height="11" rx="2"/>`)
      .join('\n    ')}
    <text x="116" y="9" class="micro dim">MORE</text>
  </g>
  <path class="rule" d="M${PAD} 320.5H${W - PAD}"/>

  <text x="${PAD}" y="346" class="micro dim">WEEKLY VOLUME<tspan class="muted">   peak ${
    weekly[peakWeek]
  } · week of ${shortDate(weeks[peakWeek][0].date)}</tspan></text>
  <path class="rule" d="M${PAD} ${trendBase + 0.5}H${W - PAD}"/>
  <path class="guide" d="M${gridX} ${halfY}H${gridX + gridW}"/>
  <text x="${gridX - 12}" y="${halfY + 4}" text-anchor="end" class="micro dim">${Math.round(peak / 2)}</text>
  <text x="${gridX - 12}" y="${trendFloor + 4}" text-anchor="end" class="micro dim">0</text>
  <path class="trend-area" d="${areaPath}"/>
  <path class="trend" d="${trendPath}"/>
  <circle class="peak" cx="${round(points[peakWeek][0])}" cy="${round(points[peakWeek][1])}" r="4.5"/>

  <text x="${PAD}" y="450" class="micro dim">black / white / quiet signal</text>
  <text x="${W - PAD}" y="450" text-anchor="end" class="micro dim">generated ${generatedAt} · refreshed every 6h</text>
</svg>
`;
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const args = parseArgs(argv.slice(2));
  if (args.help) {
    console.log(
      'usage: generate-contribution-graph.mjs [--user LOGIN] [--out FILE] [--source auto|graphql|html]',
    );
    return;
  }

  const { days, total, source } = await loadCalendar(args);
  const stats = computeStats(days);
  const grid = toGrid(days);
  const generatedAt = new Date().toISOString().slice(0, 10);

  const svg = render({ user: args.user, days, total, stats, grid, generatedAt });
  await writeFile(args.out, svg, 'utf8');

  console.log(
    `✓ ${args.out} — ${total} contributions over ${days.length} days ` +
      `(${grid.weekCount} weeks, source: ${source}, longest streak ${stats.longest}d)`,
  );
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  exit(1);
});
