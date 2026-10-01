import { writeFile } from 'node:fs/promises';

const user = process.argv[2] || 'Fai1th';
if (!/^[a-z\d-]+$/i.test(user)) throw new Error('Invalid GitHub username');
const response = await fetch(`https://github.com/users/${user}/contributions`, {
  headers: { 'User-Agent': `${user}-profile`, Accept: 'text/html' },
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`Contribution data returned ${response.status}`);
const html = await response.text();
const counts = new Map();
for (const match of html.matchAll(/<tool-tip[^>]*\sfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
  const text = match[2].trim();
  if (/^No contributions/i.test(text)) counts.set(match[1], 0);
  else {
    const number = text.match(/^([\d,]+)\s+contribution/i);
    if (number) counts.set(match[1], Number(number[1].replaceAll(',', '')));
  }
}
const days = [];
for (const match of html.matchAll(/<td\b([^>]*\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*)>/g)) {
  const attrs = match[1];
  if (!attrs.includes('ContributionCalendar-day')) continue;
  const id = attrs.match(/\sid="([^"]+)"/)?.[1];
  const level = Number(attrs.match(/data-level="(\d)"/)?.[1]);
  if (!id || !counts.has(id)) throw new Error(`Missing exact count for ${match[2]}`);
  days.push({ date: match[2], count: counts.get(id), level });
}
days.sort((a,b) => a.date.localeCompare(b.date));
if (days.length < 350 || new Set(days.map(d => d.date)).size !== days.length) throw new Error('Incomplete calendar');
const start = new Date(`${days[0].date}T00:00:00Z`);
start.setUTCDate(start.getUTCDate() - start.getUTCDay());
const millis = 86400000, pitch = 15, cell = 11, left = 52, top = 82;
const weekly = [], shades = ['#252a30','#62676d','#969a9e','#c9cccf','#f0f1f2'];
let cells = '', monthLabels = '', lastMonth = '';
for (const day of days) {
  const date = new Date(`${day.date}T00:00:00Z`);
  const week = Math.floor((date-start)/millis/7);
  weekly[week] = (weekly[week] || 0) + day.count;
  const x = left+week*pitch, y = top+date.getUTCDay()*pitch;
  cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${shades[day.level]}"><title>${day.date}: ${day.count} contributions</title></rect>`;
  const month = day.date.slice(0,7);
  if (month !== lastMonth && date.getUTCDate() <= 7) {
    monthLabels += `<text x="${x}" y="68">${date.toLocaleDateString('en-US',{month:'short',timeZone:'UTC'})}</text>`;
    lastMonth = month;
  }
}
const total = days.reduce((sum,day) => sum+day.count,0);
const peak = Math.max(1,...weekly), base = 335, chartTop = 250;
const points = weekly.map((count,week) => `${left+week*pitch+cell/2},${(base-count/peak*(base-chartTop)).toFixed(2)}`);
const right = left+(weekly.length-1)*pitch+cell;
const width = Math.max(860,right+36);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 370" role="img" aria-labelledby="title description">
<title id="title">${user}'s GitHub activity</title>
<desc id="description">${total} contributions from ${days[0].date} to ${days.at(-1).date}. Calendar and weekly line using exact public GitHub counts.</desc>
<rect width="${width}" height="370" fill="#0d1117"/>
<g font-family="Arial, sans-serif" font-size="12" fill="#a9afb7">
<text x="${left}" y="30" font-size="17" fill="#e6edf3">${total.toLocaleString('en-US')} contributions</text>
<text x="${right}" y="30" text-anchor="end">${days[0].date} — ${days.at(-1).date}</text>
${monthLabels}<text x="40" y="108" text-anchor="end">M</text><text x="40" y="138" text-anchor="end">W</text><text x="40" y="168" text-anchor="end">F</text>
${cells}
<text x="${left}" y="211">Less</text>${shades.map((shade,i)=>`<rect x="${left+34+i*15}" y="200" width="11" height="11" rx="2" fill="${shade}"/>`).join('')}<text x="${left+115}" y="211">More</text>
<text x="${left}" y="238" fill="#e6edf3">Weekly contributions</text>
<text x="${left-10}" y="${chartTop+4}" text-anchor="end">${peak}</text><text x="${left-10}" y="${base+4}" text-anchor="end">0</text>
<path d="M${left} ${base}H${right}" stroke="#383e46"/><path d="M${left} ${chartTop}H${right}" stroke="#252a30"/>
<polyline points="${points.join(' ')}" fill="none" stroke="#e6edf3" stroke-width="2" stroke-linejoin="round"/>
<text x="${left}" y="360">${days[0].date}</text><text x="${right}" y="360" text-anchor="end">${days.at(-1).date}</text>
</g></svg>\n`;
await writeFile(new URL('../assets/activity.svg',import.meta.url),svg);
console.log(JSON.stringify({user,days:days.length,total,weeks:weekly.length,peak,first:days[0].date,last:days.at(-1).date}));
