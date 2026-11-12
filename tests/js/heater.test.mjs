// Run: node tests/js/heater.test.mjs custom_components/slot_thermostat/frontend/slot-heater-card.js
import { JSDOM } from 'jsdom';
import fs from 'fs';
import assert from 'assert';
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
const { window } = dom;
window.eval(fs.readFileSync(process.argv[2], 'utf8'));
const doc = window.document;
const states = {
  'sensor.boiler_status': { state: 'heating', attributes: { friendly_name: 'Boiler', running_since: new Date(Date.now() - 72 * 60e3).toISOString(), requested_by: ['Girlies', 'Living'] } },
};
const hass = { locale: { language: 'en' }, states, entities: { 'sensor.boiler_status': { platform: 'slot_thermostat' } } };
const card = doc.createElement('slot-heater-card');
card.setConfig({ entity: 'sensor.boiler_status' });
doc.body.appendChild(card);
card.hass = hass;
const text = () => card.shadowRoot.textContent.replace(/\s+/g, ' ');
assert.match(text(), /Heating for 1 h 12 m/);
assert.match(text(), /Requested by Girlies, Living/);
assert.equal(card.shadowRoot.querySelector('ha-card').className, 'heating');
states['sensor.boiler_status'] = { state: 'cooling', attributes: { running_since: new Date(Date.now() - 40 * 60e3).toISOString(), requested_by: ['Bedroom'], waiting: ['Living'] } };
card.hass = { ...hass, states };
assert.match(text(), /Cooling for 40 m/);
assert.match(text(), /Requested by Bedroom · waiting: Living/);
assert.ok(card.shadowRoot.querySelector('ha-icon[icon="mdi:snowflake"]'));

states['sensor.boiler_status'] = { state: 'off', attributes: { friendly_name: 'Boiler', last_run_seconds: 25 * 60, last_direction: 'heat', last_started_by: ['Living'], last_on: '2026-11-12T12:05:00Z', last_off: '2026-11-12T12:30:00Z', requested_by: [] } };
card.hass = { ...hass, states };
assert.match(text(), /Heated for 25 m/);
assert.match(text(), /started by Living/);

states['sensor.boiler_status'] = { state: 'resting', attributes: { resting_until: '2026-11-12T12:40:00Z' } };
card.hass = { ...hass, states };
assert.match(text(), /Resting/);
let opened = null;
card.addEventListener('hass-more-info', (e) => (opened = e.detail.entityId));
card.shadowRoot.querySelector('ha-card').click();
assert.equal(opened, 'sensor.boiler_status');
card.remove();
console.log('HEATER CARD TESTS OK');
