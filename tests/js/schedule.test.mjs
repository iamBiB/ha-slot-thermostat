// Run: node tests/js/schedule.test.mjs custom_components/slot_thermostat/frontend/slot-schedule-card.js
import { JSDOM } from 'jsdom';
import fs from 'fs';
import assert from 'assert';

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
const { window } = dom;
window.eval(fs.readFileSync(process.argv[2], 'utf8'));
const doc = window.document;
const tick = () => new Promise((r) => setTimeout(r, 0));

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
let stored = {
  mode: 'daily',
  daily: [
    { title: 'Night', start: '22:30', end: '06:00', temp: 18 },
    { title: 'Morning', start: '06:00', end: '08:30', temp: 21.5 },
    { title: 'Evening', start: '16:00', end: '22:30', temp: 22 },
  ],
  weekly: Object.fromEntries(DAYS.map((d) => [d, []])),
};
const sent = [];
const hass = {
  locale: { language: 'en' },
  states: { 'climate.living_room': { state: 'heat', attributes: { friendly_name: 'Living room' } } },
  entities: { 'climate.living_room': { platform: 'slot_thermostat' } },
  async callWS(msg) {
    if (msg.type === 'slot_thermostat/schedule/get') return { schedule: stored, min_temp: 7, max_temp: 30, step: 0.5 };
    if (msg.type === 'slot_thermostat/schedule/set') {
      sent.push(msg.schedule);
      stored = msg.schedule;
      return { schedule: stored, min_temp: 7, max_temp: 30, step: 0.5 };
    }
    throw new Error('unknown');
  },
};

const card = doc.createElement('slot-schedule-card');
card.setConfig({ entity: 'climate.living_room' });
doc.body.appendChild(card);
card.hass = hass;
await tick();
const $ = (s) => card.shadowRoot.querySelector(s);
const $$ = (s) => [...card.shadowRoot.querySelectorAll(s)];
const text = () => card.shadowRoot.textContent.replace(/\s+/g, ' ');

// timeline: 3 slots + the tail of "Night" after midnight
assert.equal($$('.track .slot').length, 4);
assert.match(text(), /Living room · Every day · 3 slots/);
assert.match(text(), /Morning 06:00 to 08:30 21\.5°/);
assert.match(text(), /Night 22:30 to 06:00 \(\+1\) 18°/);
assert.ok($('.now'), 'now line in daily mode');
assert.equal($$('.seg[aria-label="Day"]').length, 0, 'no day picker in daily mode');

// edit a slot and save
$$('.rows button[data-act="edit"]')[0].click(); // Morning (sorted by start)
const set = (f, v) => {
  const el = $(`.form input[data-f="${f}"]`);
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
set('title', 'Wake up');
$('[data-act="temp"][data-dir="1"]').click();
$('[data-act="save"]').click();
await tick();
assert.equal(sent.length, 1);
assert.deepEqual(sent[0].daily.find((s) => s.title === 'Wake up'), { title: 'Wake up', start: '06:00', end: '08:30', temp: 22 });
assert.match(text(), /Saved Wake up/);
assert.equal($('.form'), null, 'editor closed after saving');

// an overlapping new slot is refused before anything is sent
$('[data-act="add"]').click();
assert.equal($('.form input[data-f="start"]').value, '06:00', 'new slot starts where the latest-starting slot ends');
set('start', '07:00');
set('end', '09:00');
$('[data-act="save"]').click();
await tick();
assert.equal(sent.length, 1, 'nothing sent');
assert.match(text(), /overlaps/);
$('[data-act="cancel"]').click();

// delete
$$('.rows button[data-act="edit"]')[1].click(); // Evening
$('[data-act="delete"]').click();
await tick();
assert.equal(sent.length, 2);
assert.equal(sent[1].daily.length, 2);

// per weekday: starts as a copy of the daily list, shows a day picker
$('[data-act="mode"][data-mode="weekly"]').click();
await tick();
assert.equal(sent[2].mode, 'weekly');
assert.ok(DAYS.every((d) => sent[2].weekly[d].length === 2));
assert.equal($$('.seg[aria-label="Day"] button').length, 7);

// clear Saturday, then copy Monday to the weekend
$('[data-act="day"][data-day="sat"]').click();
$$('.rows button[data-act="edit"]')[0].click();
$('[data-act="delete"]').click();
await tick();
assert.equal(stored.weekly.sat.length, 1);
$('[data-act="day"][data-day="mon"]').click();
$('[data-act="copy"][data-to="weekend"]').click();
await tick();
assert.equal(stored.weekly.sat.length, 2);
assert.equal(stored.weekly.sun.length, 2);
assert.match(text(), /Copied Mon to weekend/);

card.remove();
console.log('SCHEDULE CARD TESTS OK');
