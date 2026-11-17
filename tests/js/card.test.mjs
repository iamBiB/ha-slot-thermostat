// Run: npm install && node tests/js/card.test.mjs custom_components/slot_thermostat/frontend/slot-thermostat-card.js
import { JSDOM } from 'jsdom';
import fs from 'fs';
import assert from 'assert';
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.eval(fs.readFileSync(process.argv[2], 'utf8'));
const doc = window.document;
const tick = () => new Promise((r) => setTimeout(r, 0));

let saved = { mode: 'daily', daily: [{ title: 'Leaving home', start: '07:00', end: '10:00', temp: 21 }], weekly: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } };
const calls = [];
const hass = {
  locale: { language: 'en' }, config: { unit_system: { temperature: '°C' } },
  entities: { 'climate.living': { platform: 'slot_thermostat' } },
  states: { 'climate.living': { state: 'heat_cool', attributes: {
    friendly_name: 'Living', hvac_modes: ['heat', 'cool', 'heat_cool', 'off'], hvac_action: 'cooling', preset_mode: 'schedule',
    current_temperature: 24.1, temperature: 21, cool_above: 23, active_slot: 'Leaving home', slot_temperature: 21, slot_end: new Date(Date.now() + 3600e3).toISOString(),
    current_humidity: 46, min_temp: 5, max_temp: 30, target_temp_step: 0.5 } },
    'sensor.living_humidity': { state: '52.4', attributes: {} } },
  callWS: async (msg) => {
    calls.push(msg);
    if (msg.type.endsWith('/get')) return { schedule: JSON.parse(JSON.stringify(saved)), min_temp: 5, max_temp: 30, step: 0.5 };
    saved = JSON.parse(JSON.stringify(msg.schedule)); return { schedule: saved, min_temp: 5, max_temp: 30, step: 0.5 };
  },
  callService: async (...args) => calls.push(args),
};
const Card = window.customElements.get('slot-thermostat-card');
assert.equal(JSON.stringify(Card.getStubConfig(hass)), '{"entity":"climate.living"}');
const card = doc.createElement('slot-thermostat-card');
card.setConfig({ entity: 'climate.living' });
doc.body.appendChild(card);
card.hass = hass;
await tick(); await tick();
const root = card.shadowRoot;
const $ = (s) => root.querySelector(s);
const $$ = (s) => [...root.querySelectorAll(s)];
const text = () => root.textContent.replace(/\s+/g, ' ');

// collapsed by default: one row with a summary, opens on demand
assert.ok(!$('input[data-f="title"]'));
assert.match($('.toggle').textContent, /Schedule\s*· 1 slot today/);
$('.toggle').click();
assert.equal($('.toggle').getAttribute('aria-expanded'), 'true');
assert.match(text(), /Cooling/); assert.match(text(), /cools above 23\.0°/); assert.match(text(), /Leaving home · 21.0° · until/);
assert.deepStrictEqual($$('[data-mode]').map((b) => b.textContent), ['Heat', 'Cool', 'Heat/Cool', 'Off']);
assert.ok($('[data-mode="heat_cool"]').classList.contains('on'));
assert.equal($('[data-mode="heat_cool"]').getAttribute('aria-pressed'), 'true');
assert.equal($$('input[data-f="title"]').length, 1);
assert.equal($('[data-act="save"]').disabled, true);
assert.equal($$('.timeline .block').length, 1);

// add a slot: starts where the previous ended
$('[data-act="add"]').click();
let starts = $$('input[data-f="start"]').map((i) => i.value);
assert.deepStrictEqual(starts, ['07:00', '10:00']);
assert.equal($('[data-act="save"]').disabled, false);
assert.match($('.msg').textContent, /Unsaved/);

// make it overlap -> error + save disabled
const s2 = $$('input[data-f="start"]')[1];
s2.value = '09:00'; s2.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.match($('.msg').textContent, /overlaps/); assert.equal($('[data-act="save"]').disabled, true);
s2.value = '10:00'; s2.dispatchEvent(new window.Event('input', { bubbles: true }));
const t2 = $$('input[data-f="title"]')[1];
t2.value = 'Returning'; t2.dispatchEvent(new window.Event('input', { bubbles: true }));
const temp2 = $$('input[data-f="temp"]')[1];
temp2.value = '22.5'; temp2.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal($('.msg').textContent, 'Unsaved changes');
assert.equal($$('.timeline .block').length, 2);

// end of day is stored as 24:00 and shown as 00:00 without a +1 badge
saved.daily.length;
const e2b = $$('input[data-f="end"]')[1];
e2b.value = '00:00'; e2b.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(root.querySelector('[data-plus="1"]').textContent, '');
e2b.value = '17:00'; e2b.dispatchEvent(new window.Event('input', { bubbles: true }));
// past midnight badge
const e2 = $$('input[data-f="end"]')[1];
e2.value = '02:00'; e2.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(root.querySelector('[data-plus="1"]').textContent, '+1');
e2.value = '17:00'; e2.dispatchEvent(new window.Event('input', { bubbles: true }));

// can't collapse with unsaved edits
$('.toggle').click();
assert.ok($('input[data-f="title"]'));
assert.match($('.msg').textContent, /Save or revert/);
// save
$('[data-act="save"]').click(); await tick(); await tick();
assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.daily)).map((s) => [s.title, s.start, s.end, s.temp]), [['Leaving home', '07:00', '10:00', 21], ['Returning', '10:00', '17:00', 22.5]]);
assert.match($('.msg').textContent, /Saved/);

// weekly: switching copies daily slots into every day; day chips; copy
$('[data-smode="weekly"]').click();
assert.equal($$('.days button').length, 7);
$('[data-day="sat"]').click();
$$('.del')[0].click(); $$('.del')[0].click();
assert.match(text(), /No slots on Sat/);
$('[data-copy="weekend"]').click();
$('[data-day="sun"]').click();
assert.match(text(), /No slots on Sun/);
$('[data-day="mon"]').click();
assert.equal($$('input[data-f="title"]').length, 2);
// revert
$('[data-act="revert"]').click();
assert.equal($('[data-smode="daily"]').className, 'on');

// head buttons call services
$('[data-preset="manual"]').click(); $('[data-mode="cool"]').click();
assert.deepStrictEqual(calls.filter(Array.isArray).map((c) => c[1]), ['set_preset_mode', 'set_hvac_mode']);
// re-render on hass update keeps editor inputs (focus safety)
const before = $$('input[data-f="title"]')[0];
card.hass = { ...hass };
assert.equal($$('input[data-f="title"]')[0], before);

// The card draws its own dial (the Atrium design), with a humidity chip and round mode buttons
const card2 = doc.createElement('slot-thermostat-card');
card2.setConfig({ entity: 'climate.living', schedule_open: true });
doc.body.appendChild(card2);
card2.hass = hass;
await tick(); await tick();
const r2 = card2.shadowRoot;
const q2 = (sel) => r2.querySelector(sel);
assert.ok(q2('.dial .dial__knob'), 'own dial');
assert.equal(q2('.dial').dataset.kind, 'cool', 'arc colour follows hvac_action');
assert.equal(q2('.dial__value').textContent, '21.0°');
assert.equal(q2('.dial__status').textContent, 'Cooling to');
assert.equal(q2('.dial__nowchip').textContent, 'Now 24.1°');
assert.equal(q2('.card__title').textContent, 'Living');
assert.match(q2('.card__head .chip').textContent, /46%/);
assert.equal([...r2.querySelectorAll('.mode')].length, 4, 'round mode buttons');
const presetBtns = [...r2.querySelectorAll('.presets button')];
assert.equal(presetBtns.map((b) => b.textContent.trim()).join(','), 'Schedule,Manual');
assert.equal(presetBtns[0].className, 'on');
assert.ok(presetBtns[0].querySelector('ha-icon[icon="mdi:calendar-clock"]'));
presetBtns[1].click();
assert.equal(JSON.stringify(calls.filter(Array.isArray).at(-1)), JSON.stringify(['climate', 'set_preset_mode', { entity_id: 'climate.living', preset_mode: 'manual' }]));
assert.match(q2('.dialbar__note').textContent, /Leaving home · 21.0° · until/);
assert.ok(r2.querySelector('.editor .grid'), 'schedule editor still there');

// a state update that changes nothing keeps the buttons (no flicker on hover)
const schedBtn = q2('[data-preset="schedule"]');
card2.hass = { ...hass };
assert.equal(q2('[data-preset="schedule"]'), schedBtn);

// + sends one set_temperature after a short pause, and the dial shows the new value at once
q2('[data-step="1"]').click();
assert.equal(q2('.dial__value').textContent, '21.5°');
await new Promise((r) => setTimeout(r, 700));
assert.equal(JSON.stringify(calls.filter(Array.isArray).at(-1)), JSON.stringify(['climate', 'set_temperature', { entity_id: 'climate.living', temperature: 21.5 }]));

// info_icons: any entities, with an icon each; a chip opens its entity
const states3 = { ...hass.states, 'sensor.living_humidity': { state: '52.4', attributes: { device_class: 'humidity' } },
  'sensor.co2': { state: '612', attributes: { unit_of_measurement: 'ppm', friendly_name: 'CO2' } } };
card2.setConfig({ entity: 'climate.living', info_icons: [{ entity: 'sensor.living_humidity', icon: 'mdi:water' }, { entity: 'sensor.co2', icon: 'mdi:molecule-co2' }] });
card2.hass = { ...hass, states: states3 };
const chips = [...r2.querySelectorAll('.card__head .chip')];
assert.deepStrictEqual(chips.map((c) => c.textContent), ['52%', '612 ppm']);
assert.ok(chips[1].querySelector('ha-icon[icon="mdi:molecule-co2"]'));
let more = null;
card2.addEventListener('hass-more-info', (e) => (more = e.detail.entityId));
chips[1].click();
assert.equal(more, 'sensor.co2');
// no humidity on the thermostat: the humidity sensor on the temperature sensor's device
const noHum = JSON.parse(JSON.stringify(hass.states));
delete noHum['climate.living'].attributes.current_humidity;
noHum['climate.living'].attributes.temperature_sensors = ['sensor.living_temp'];
noHum['sensor.living_temp'] = { state: '21.2', attributes: { device_class: 'temperature' } };
noHum['sensor.living_hum'] = { state: '61', attributes: { device_class: 'humidity' } };
card2.setConfig({ entity: 'climate.living' });
card2.hass = { ...hass, states: noHum, entities: { ...hass.entities,
  'sensor.living_temp': { entity_id: 'sensor.living_temp', device_id: 'dev1' },
  'sensor.living_hum': { entity_id: 'sensor.living_hum', device_id: 'dev1' } } };
assert.match(q2('.card__head .chip').textContent, /61%/);
card2.setConfig({ entity: 'climate.living', info_icons: [] });
card2.hass = { ...hass };
assert.equal(q2('.card__head .chip'), null);
card2.remove();
// after saving it collapses again on demand
$('.toggle').click();
assert.ok(!$('input[data-f="title"]'));
console.log('CARD TESTS OK');
