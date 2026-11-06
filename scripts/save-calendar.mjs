// Turns Google Calendar "list events" responses into calendar.json, which the quick-task rules read.
// Used by the daily Claude scheduled task ("Scrummaster: refresh calendar"), which fetches the next two weeks
// through Claude's Google Calendar connector and runs:
//
//   node scripts/save-calendar.mjs <response.json> [<page2.json> ...]
//
// Only the title and the time of each meeting are kept (no attendees, descriptions or links).
// Cancelled meetings, meetings you declined, and working-location / out-of-office entries are skipped.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'calendar.json');
const files = process.argv.slice(2);
if (!files.length) { console.error('Usage: node scripts/save-calendar.mjs <list_events response.json> [...]'); process.exit(1); }

const events = [];
for (const f of files) {
  const raw = JSON.parse(readFileSync(f, 'utf-8'));
  for (const e of raw.events || raw.items || []) {
    if (e.status === 'cancelled') continue;
    if (e.eventType && !['DEFAULT', 'FOCUS_TIME', 'FROM_GMAIL'].includes(e.eventType)) continue;
    const me = (e.attendees || []).find((a) => a.self);
    if (me?.responseStatus === 'declined') continue;
    const allDay = !e.start?.dateTime;
    events.push({ title: e.summary || '(no title)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, allDay });
  }
}
events.sort((a, b) => a.start.localeCompare(b.start));

const out = { updatedAt: new Date().toISOString(), events };
writeFileSync(OUT + '.tmp', JSON.stringify(out, null, 2));
renameSync(OUT + '.tmp', OUT); // replace in one step, so the app never reads a half-written file
console.log(`Saved ${events.length} events to ${OUT}`);
