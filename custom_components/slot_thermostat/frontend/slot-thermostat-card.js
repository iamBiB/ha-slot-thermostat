/*
 * Slot Thermostat card — bundled with the Slot Thermostat integration.
 * Shows the thermostat and edits its schedule: named slots with start, end
 * and temperature, daily or per weekday.
 *
 *   type: custom:slot-thermostat-card
 *   entity: climate.living_room
 *   name: Living room        # optional
 *   show_schedule: true      # optional, false hides the editor
 *   dial: true               # optional, false shows the temperatures as text
 *   info_icons:              # optional chips in the top-right corner (any number)
 *     - entity: sensor.living_room_humidity
 *       icon: mdi:water-outline        # optional, else by the sensor's type
 *   Without info_icons the card shows the room's humidity by itself; [] shows none.
 */
const VERSION = '0.2.0';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const WEEKDAYS = DAYS.slice(0, 5);
const WEEKEND = ['sat', 'sun'];
const DAY_MIN = 1440;
const WEEK_MIN = 7 * DAY_MIN;

const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clone = (o) => JSON.parse(JSON.stringify(o));

function parseTime(v, allow24 = false) {
    const m = /^([01]?\d|2[0-4]):([0-5]\d)$/.exec(String(v ?? '').trim());
    if (!m) return null;
    const t = +m[1] * 60 + +m[2];
    if (t > DAY_MIN || (t === DAY_MIN && !allow24)) return null;
    return t;
}
const fmtTime = (t) => `${String(Math.floor((t % DAY_MIN) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const slotLabel = (s) => s.title || `${s.start}–${s.end}`;

/** Same rules as schedule.py: returns an error message or ''. */
function validate(schedule, min, max) {
    const lists = [['daily', schedule.daily], ...DAYS.map((d) => [d, schedule.weekly[d]])];
    for (const [where, list] of lists) {
        for (const s of list) {
            const start = parseTime(s.start);
            const end = parseTime(s.end, true);
            const name = s.title || s.start || '?';
            const place = where === 'daily' ? '' : ` (${DAY_NAMES[where]})`;
            if (start === null) return `'${name}'${place}: invalid start time`;
            if (end === null) return `'${name}'${place}: invalid end time`;
            if (start === end) return `'${name}'${place} starts and ends at the same time`;
            const t = parseFloat(s.temp);
            if (Number.isNaN(t)) return `'${name}'${place} needs a temperature`;
            if (t < min || t > max) return `'${name}'${place}: ${t}° is outside ${min}–${max}°`;
        }
    }
    for (const mode of ['daily', 'weekly']) {
        const iv = weekIntervals(schedule, mode);
        const ext = iv.concat(iv.map((i) => ({ ...i, start: i.start + WEEK_MIN, end: i.end + WEEK_MIN })));
        for (let k = 1; k < ext.length; k++) {
            if (ext[k].start < ext[k - 1].end) {
                const day = mode === 'daily' ? '' : ` on ${DAY_NAMES[DAYS[Math.floor(ext[k].start / DAY_MIN) % 7]]}`;
                return `'${slotLabel(ext[k - 1].slot)}' overlaps '${slotLabel(ext[k].slot)}'${day}`;
            }
        }
    }
    return '';
}

function weekIntervals(schedule, mode) {
    const out = [];
    DAYS.forEach((day, i) => {
        const list = mode === 'daily' ? schedule.daily : schedule.weekly[day];
        for (const slot of list) {
            const s = parseTime(slot.start);
            let e = parseTime(slot.end, true);
            if (s === null || e === null) continue;
            e %= DAY_MIN;
            if (e <= s) e += DAY_MIN;
            out.push({ start: i * DAY_MIN + s, end: i * DAY_MIN + e, slot });
        }
    });
    return out.sort((a, b) => a.start - b.start);
}

/** Hue from blue (cool) to orange (warm). */
function tempColor(t) {
    const x = Math.max(0, Math.min(1, (t - 16) / 8));
    return `hsl(${Math.round(210 - x * 185)} 75% 55%)`;
}

// The Atrium dial: a 270° arc starting at 135°, in a 280×280 box.
const DIAL = { C: 140, R: 112, A0: 135, SWEEP: 270 };
const dialPt = (a) => [DIAL.C + DIAL.R * Math.cos((a * Math.PI) / 180), DIAL.C + DIAL.R * Math.sin((a * Math.PI) / 180)];
const dialArc = (a, b) => {
    const [x1, y1] = dialPt(a);
    const [x2, y2] = dialPt(b);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${DIAL.R} ${DIAL.R} 0 ${b - a > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};
const MODE_ICON = { heat: 'mdi:fire', cool: 'mdi:snowflake', heat_cool: 'mdi:sun-snowflake-variant', auto: 'mdi:autorenew', off: 'mdi:power' };
const CHIP_ICON = {
    humidity: 'mdi:water-outline', temperature: 'mdi:thermometer', carbon_dioxide: 'mdi:molecule-co2',
    pm25: 'mdi:blur', illuminance: 'mdi:brightness-5', pressure: 'mdi:gauge', battery: 'mdi:battery',
};
const MODE_LABEL = { heat: 'Heat', cool: 'Cool', heat_cool: 'Heat/Cool', auto: 'Auto', off: 'Off' };

const CSS = `
:host {
  display: block;
  /* Colours come from the theme (the Atrium theme gives the card its look). */
  --st-text: var(--primary-text-color);
  --st-muted: var(--secondary-text-color);
  --st-fill: color-mix(in srgb, var(--primary-text-color) 5.5%, transparent);
  --st-fill-strong: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
  --st-line: var(--divider-color);
  --st-accent: var(--primary-color);
  --st-on-accent: var(--text-primary-color, #fff);
  --st-heat: var(--state-climate-heat-color, #ff9f5a);
  --st-cool: var(--state-climate-cool-color, #4d9bff);
  --st-ok: var(--success-color, #5fd6a2);
  --st-bg: var(--ha-card-background, var(--card-background-color, #1e2127));
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 2px solid var(--st-accent); outline-offset: 2px; }
ha-card { padding: 20px; overflow: hidden; color: var(--st-text); }
.row { display: flex; align-items: center; gap: 8px; }
.between { justify-content: space-between; }
.name { font-size: 16px; font-weight: 600; }
.muted { color: var(--st-muted); }
.small { font-size: 12px; }
.temps { display: flex; align-items: baseline; gap: 12px; margin: 10px 0 2px; }
.cur { font-size: 44px; font-weight: 600; letter-spacing: -.03em; line-height: 1; font-variant-numeric: tabular-nums; }
.target { font-size: 17px; color: var(--st-muted); font-variant-numeric: tabular-nums; }
.pill { font-size: 12px; font-weight: 500; padding: 4px 10px; border-radius: 999px; background: var(--st-fill); color: var(--st-muted); display: inline-flex; align-items: center; gap: 6px; --mdc-icon-size: 16px; }
.pill.heating { background: color-mix(in srgb, var(--st-heat) 16%, transparent); color: var(--st-heat); }
.pill.cooling { background: color-mix(in srgb, var(--st-cool) 16%, transparent); color: var(--st-cool); }
.status { margin: 8px 0 14px; font-size: 13px; color: var(--st-muted); }
.status.center { text-align: center; margin: 12px 0 0; }
.status a { color: var(--st-accent); cursor: pointer; text-decoration: none; margin-left: 8px; font-weight: 600; }
/* Schedule | Manual: segmented pills; the selected one shows the mode colour */
.presets { display: flex; gap: 2px; padding: 4px; max-width: 360px; margin: 18px auto 0; border-radius: 999px; background: var(--st-fill); border: 1px solid var(--st-line); }
.presets button { flex: 1 1 0; border: 0; background: none; padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 500; color: var(--st-muted); display: flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer; --mdc-icon-size: 18px; transition: background .18s, color .18s; }
.presets button:hover { color: var(--st-text); }
.presets button.on { background: var(--st-fill-strong); color: var(--st-text); }
.presets button.on ha-icon { color: var(--mode-color); }
.controls { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.seg { display: inline-flex; gap: 2px; padding: 4px; border-radius: 999px; background: var(--st-fill); border: 1px solid var(--st-line); }
.seg button { border: 0; background: none; padding: 7px 14px; border-radius: 999px; font-size: 13px; font-weight: 500; color: var(--st-muted); cursor: pointer; transition: background .18s, color .18s; }
.seg button:hover { color: var(--st-text); }
.seg button.on { background: var(--st-fill-strong); color: var(--st-text); }
.stepper { display: inline-flex; align-items: center; gap: 10px; }
.round { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; border: 1px solid var(--st-line); background: var(--st-fill); color: var(--st-text); font-size: 20px; cursor: pointer; line-height: 1; transition: background .18s; }
.round:hover { background: var(--st-fill-strong); }
.round:disabled { opacity: .35; cursor: default; }
.setval { min-width: 56px; text-align: center; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
hr { border: 0; border-top: 1px solid var(--st-line); margin: 16px 0; }
/* the schedule row, like a list row with an icon */
.toggle { width: 100%; display: flex; align-items: center; gap: 12px; margin-top: 16px; padding: 14px 0 0; border: 0; border-top: 1px solid var(--st-line); background: none; color: var(--st-text); font-size: 14px; font-weight: 600; cursor: pointer; text-align: left; --mdc-icon-size: 20px; }
.toggle .ico { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--st-fill-strong); color: var(--st-muted); flex: none; }
.toggle[aria-expanded="true"] .ico { background: var(--st-accent); color: var(--st-on-accent); }
.toggle .small { font-weight: 400; color: var(--st-muted); }
.toggle .chev { margin-left: auto; color: var(--st-muted); }
.embedded { margin-top: 16px; }
.days { display: flex; gap: 2px; flex-wrap: wrap; padding: 4px; margin: 12px 0; border-radius: 999px; background: var(--st-fill); border: 1px solid var(--st-line); }
.days button { flex: 1 1 0; min-width: 40px; border: 0; background: none; color: var(--st-muted); border-radius: 999px; padding: 7px 0; font-size: 13px; font-weight: 500; cursor: pointer; position: relative; }
.days button.on { background: var(--st-fill-strong); color: var(--st-text); }
.days button.has::after { content: ''; position: absolute; left: 50%; bottom: 3px; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: currentColor; opacity: .5; }
.timeline { position: relative; height: 44px; border-radius: 14px; background: var(--st-fill); border: 1px solid var(--st-line); margin: 12px 0 6px; overflow: hidden; }
.block { position: absolute; top: 4px; bottom: 4px; border-radius: 10px; font-size: 12px; font-weight: 700; color: #0e1116; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 6px; line-height: 34px; text-align: center; }
.now { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--st-text); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-text) 18%, transparent); }
.ticks { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--st-muted); margin-bottom: 12px; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 92px 92px 74px 32px; gap: 8px; align-items: center; }
.grid .h { font-size: 12px; color: var(--st-muted); }
.grid input { width: 100%; font: inherit; font-size: 14px; padding: 8px 10px; border-radius: 12px; border: 1px solid var(--st-line); background: var(--st-fill); color: var(--st-text); color-scheme: light dark; }
.grid input:focus { outline: 2px solid var(--st-accent); outline-offset: -1px; }
.endwrap { position: relative; }
.plus1 { position: absolute; right: 26px; top: 50%; transform: translateY(-50%); font-size: 10px; color: var(--st-muted); pointer-events: none; }
.del { width: 32px; height: 32px; border: 0; background: none; color: var(--st-muted); cursor: pointer; font-size: 18px; border-radius: 50%; }
.del:hover { color: var(--error-color); background: var(--st-fill-strong); }
.empty { padding: 12px 0; text-align: center; color: var(--st-muted); font-size: 14px; }
.link { border: 0; background: none; color: var(--st-accent); font-size: 13px; font-weight: 600; cursor: pointer; padding: 6px 0; }
.copy { font-size: 13px; color: var(--st-muted); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.copy .link { padding: 2px 0; }
.foot { display: flex; align-items: center; gap: 10px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
.msg { flex: 1 1 auto; font-size: 13px; }
.msg.err { color: var(--error-color); }
.msg.ok { color: var(--success-color, #43a047); }
.btn { border: 0; border-radius: 999px; padding: 9px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn.primary { background: var(--st-accent); color: var(--st-on-accent); }
.btn.flat { background: var(--st-fill-strong); color: var(--st-text); }
.btn:disabled { opacity: .4; cursor: default; }
.warn { color: var(--error-color); padding: 8px 0; font-size: 14px; }
/* header: name and what it's doing, humidity on the right */
.card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.card__titles { min-width: 0; }
.card__title { display: block; max-width: 100%; border: 0; background: none; padding: 0; font-size: 16px; font-weight: 600; text-align: left; color: var(--st-text); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card__sub { font-size: 13px; color: var(--st-muted); margin-top: 2px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: var(--st-fill); font-size: 12px; font-weight: 500; color: var(--st-muted); white-space: nowrap; flex: none; --mdc-icon-size: 16px; }
.chip[hidden] { display: none; }
.info { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; flex: none; max-width: 60%; }
.card__head .chip { padding: 6px 12px; font-size: 13px; border: 0; cursor: pointer; }
.card__head .chip:hover { background: var(--st-fill-strong); }

/* the dial: drag the knob (only the knob, so scrolling past it is safe) */
.dial { --dial: var(--st-heat); position: relative; width: min(100%, 290px); aspect-ratio: 1; margin: 0 auto -30px; }
.dial[data-kind="cool"] { --dial: var(--st-cool); }
.dial[data-kind="steady"] { --dial: var(--st-ok); }
.dial[data-kind="off"] { --dial: var(--st-muted); }
.dial__svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; touch-action: pan-y; }
.dial__track { fill: none; stroke: var(--st-fill-strong); stroke-width: 16; stroke-linecap: round; }
.dial__fill { fill: none; stroke: var(--dial); stroke-width: 16; stroke-linecap: round; transition: stroke .3s; }
.dial__now { fill: var(--st-text); stroke: var(--st-bg); stroke-width: 2; }
.dial__knob { cursor: grab; touch-action: none; outline: none; }
.dial__knob:active { cursor: grabbing; }
.dial__hit { fill: transparent; }
.dial__thumb { fill: #fff; filter: drop-shadow(0 3px 6px rgba(0, 0, 0, .4)); }
.dial__pip { fill: var(--dial); }
.dial__knob:focus-visible .dial__thumb { stroke: var(--st-accent); stroke-width: 3; }
.dial[data-kind="off"] .dial__fill, .dial[data-kind="off"] .dial__knob { display: none; }
.dial__center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; pointer-events: none; text-align: center; }
.dial__status { font-size: 13px; color: var(--st-muted); }
.dial__status[hidden] { display: none; }
.dial__value { font-size: 60px; font-weight: 600; letter-spacing: -.04em; line-height: 1; font-variant-numeric: tabular-nums; }
.dial[data-kind="off"] .dial__value { font-size: 44px; }

/* − note + */
.dialbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 2px 0 18px; }
.dialbar__note { flex: 1; min-width: 0; font-size: 13px; color: var(--st-muted); text-align: center; }
.dialbar__note a { color: var(--st-accent); cursor: pointer; margin-left: 6px; font-weight: 600; }
.dialbar .setval { flex: 1; }

/* modes: one round button each, with a caption */
.modes { display: flex; justify-content: space-between; gap: 8px; }
.mode { display: flex; flex-direction: column; align-items: center; gap: 8px; flex: 1; min-width: 0; border: 0; background: none; padding: 0; cursor: pointer; font-size: 12.5px; color: var(--st-muted); }
.mode__icon { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; background: var(--st-fill); border: 1px solid var(--st-line); color: var(--st-text); transition: background .2s, color .2s; --mdc-icon-size: 22px; }
.mode:hover .mode__icon { background: var(--st-fill-strong); }
.mode.on { color: var(--st-text); }
.mode.on .mode__icon { background: var(--st-accent); color: var(--st-on-accent); border-color: transparent; }
.mode__label { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

@media (max-width: 480px) {
  .grid { grid-template-columns: minmax(0, 1fr) 80px 80px 64px 28px; gap: 4px; }
  .grid input { padding: 6px 4px; font-size: 13px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; }
}
`;

class SlotThermostatCard extends HTMLElement {
    static getStubConfig(hass) {
        const ents = hass?.entities || {};
        const entity = Object.keys(ents).find((id) => ents[id].platform === 'slot_thermostat') || '';
        return { entity };
    }

    setConfig(config) {
        if (!config || !config.entity) throw new Error('Set `entity` to a Slot Thermostat climate entity');
        const changed = this._config && this._config.entity !== config.entity;
        this._config = { show_schedule: true, schedule_open: false, ...config };
        if (this._open === undefined) this._open = !!this._config.schedule_open;
        if (changed || !this._draft) {
            this._saved = null;
            this._draft = null;
            this._loadState = 'idle';
        }
        this._topHtml = this._headHtml = null;
        if (this._root) this._renderEditor();
    }

    getCardSize() {
        const dial = this._config?.dial === false ? 0 : 5;
        return (this._config?.show_schedule === false ? 4 : 5) + dial;
    }

    getGridOptions() {
        return { columns: 12, min_columns: 6, rows: 'auto' };
    }

    set hass(hass) {
        this._hass = hass;
        if (!this._root) this._build();
        const a = hass.states[this._config.entity]?.attributes;
        if (this._sent && a && (Date.now() > this._sent.until || +a.temperature === this._sent.v)) this._sent = null;
        this._renderTop();
        if (!this._dragging) this._paintDial();
        this._renderHead();
        if (this._config.show_schedule !== false && this._loadState === 'idle') this._load();
        if (this._draft) this._paintTimeline();
        if (this._schedEl) this._schedEl.hass = hass;
    }

    disconnectedCallback() {
        clearTimeout(this._debounce);
        clearTimeout(this._sentTimer);
        clearTimeout(this._msgTimer);
    }

    get _stateObj() {
        return this._hass?.states[this._config.entity];
    }

    _build() {
        this._root = this.attachShadow({ mode: 'open' });
        this._root.innerHTML = `<style>${CSS}</style><ha-card><div class="top"></div><div class="dialbox"></div><div class="head"></div><div class="editor"></div></ha-card>`;
        this._top = this._root.querySelector('.top');
        this._dialBox = this._root.querySelector('.dialbox');
        this._top.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-more]');
            const id = chip ? chip.dataset.more : e.target.closest('[data-act="more"]') ? this._config.entity : null;
            if (id) this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: id }, bubbles: true, composed: true }));
        });
        if (this._config.dial !== false) this._buildDial();
        this._head = this._root.querySelector('.head');
        this._editor = this._root.querySelector('.editor');
        this._day = DAYS[(new Date().getDay() + 6) % 7];
        this._head.addEventListener('click', (e) => this._onHeadClick(e));
        this._editor.addEventListener('click', (e) => this._onEditorClick(e));
        this._editor.addEventListener('input', (e) => this._onEditorInput(e));
        this._editor.addEventListener('change', (e) => this._onEditorInput(e));
    }

    // ------------------------------------------------------------- data

    async _load() {
        this._loadState = 'loading';
        try {
            const res = await this._hass.callWS({ type: 'slot_thermostat/schedule/get', entity_id: this._config.entity });
            this._limits = { min: res.min_temp, max: res.max_temp, step: res.step };
            this._saved = clone(res.schedule);
            this._draft = clone(res.schedule);
            this._loadState = 'loaded';
            this._msg = null;
        } catch (err) {
            this._loadState = 'error';
            this._msg = { err: true, text: err?.message || String(err) };
        }
        this._renderEditor();
    }

    async _save() {
        const error = validate(this._draft, this._limits.min, this._limits.max);
        if (error) return;
        this._saving = true;
        this._refreshState();
        try {
            const res = await this._hass.callWS({
                type: 'slot_thermostat/schedule/set',
                entity_id: this._config.entity,
                schedule: this._draft,
            });
            this._saved = clone(res.schedule);
            this._draft = clone(res.schedule);
            this._msg = { err: false, text: 'Saved' };
            clearTimeout(this._msgTimer);
            this._msgTimer = setTimeout(() => {
                this._msg = null;
                this._refreshState();
            }, 2500);
        } catch (err) {
            this._msg = { err: true, text: err?.message || String(err) };
        }
        this._saving = false;
        this._renderEditor();
    }

    get _list() {
        return this._draft.mode === 'daily' ? this._draft.daily : this._draft.weekly[this._day];
    }

    get _dirty() {
        return JSON.stringify(this._draft) !== JSON.stringify(this._saved);
    }

    // ------------------------------------------------------------- dial

    _range() {
        const a = this._stateObj?.attributes || {};
        const min = Number.isFinite(+a.min_temp) ? +a.min_temp : 7;
        const max = Number.isFinite(+a.max_temp) && +a.max_temp > min ? +a.max_temp : min + 1;
        return { min, max };
    }

    _step() {
        const a = this._stateObj?.attributes || {};
        return +a.target_temp_step || this._limits?.step || 0.5;
    }

    _snap(v) {
        const { min, max } = this._range();
        const step = this._step();
        return Math.min(max, Math.max(min, Math.round(Math.round(v / step) * step * 100) / 100));
    }

    /** The target on screen: a drag or stepper preview, then the value just sent
     *  (until the thermostat reports it, max 3 s), then the thermostat's own. */
    _target() {
        if (this._preview != null) return this._preview;
        if (this._sent) return this._sent.v;
        const t = this._stateObj?.attributes?.temperature;
        if (t != null && Number.isFinite(+t)) return +t;
        const cur = this._stateObj?.attributes?.current_temperature;
        return cur != null ? this._snap(+cur) : this._range().min;
    }

    _nudge(dir) {
        if (this._stateObj?.state === 'off') return;
        this._preview = this._snap(this._target() + dir * this._step());
        this._paintDial();
        this._renderHead();
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this._sendTarget(this._preview), 600);
    }

    _sendTarget(v) {
        clearTimeout(this._debounce);
        this._preview = null;
        if (v == null) return;
        this._sent = { v, until: Date.now() + 3000 };
        clearTimeout(this._sentTimer);
        this._sentTimer = setTimeout(() => {
            this._sent = null;
            this._paintDial();
            this._renderHead();
        }, 3000);
        this._hass.callService('climate', 'set_temperature', { entity_id: this._config.entity, temperature: v });
        this._paintDial();
        this._renderHead();
    }

    _buildDial() {
        this._dialBox.innerHTML = `
          <div class="dial" data-kind="heat">
            <svg class="dial__svg" viewBox="0 0 280 280">
              <path class="dial__track" d="${dialArc(DIAL.A0, DIAL.A0 + DIAL.SWEEP)}"/><path class="dial__fill"/><circle class="dial__now" r="5"/>
              <g class="dial__knob" tabindex="0" role="slider" aria-label="Target temperature">
                <circle class="dial__hit" r="24"/><circle class="dial__thumb" r="13"/><circle class="dial__pip" r="5"/>
              </g>
            </svg>
            <div class="dial__center"><span class="dial__status"></span><span class="dial__value"></span><span class="chip dial__nowchip"></span></div>
          </div>`;
        const q = (s) => this._dialBox.querySelector(s);
        this._d = { dial: q('.dial'), svg: q('.dial__svg'), fill: q('.dial__fill'), now: q('.dial__now'), knob: q('.dial__knob'),
            status: q('.dial__status'), value: q('.dial__value'), nowChip: q('.dial__nowchip') };
        const { knob, svg } = this._d;
        // Only the knob starts a drag; the rest of the dial lets the page scroll.
        knob.addEventListener('pointerdown', (e) => {
            if (this._stateObj?.state === 'off') return;
            knob.setPointerCapture?.(e.pointerId);
            e.preventDefault();
            knob.focus({ preventScroll: true });
            this._dragging = true;
            this._preview = this._target();
            this._dragFrom = this._preview;
        });
        knob.addEventListener('pointermove', (e) => {
            if (!this._dragging) return;
            const r = svg.getBoundingClientRect();
            let a = (Math.atan2(((e.clientY - r.top) / r.height) * 280 - DIAL.C, ((e.clientX - r.left) / r.width) * 280 - DIAL.C) * 180) / Math.PI;
            if (a < 90) a += 360;
            const { min, max } = this._range();
            this._preview = this._snap(min + ((Math.min(DIAL.A0 + DIAL.SWEEP, Math.max(DIAL.A0, a)) - DIAL.A0) / DIAL.SWEEP) * (max - min));
            this._paintDial();
        });
        const release = () => {
            if (!this._dragging) return;
            this._dragging = false;
            // one service call per drag, on release (none if the value didn't change)
            if (this._preview != null && this._preview !== this._dragFrom) this._sendTarget(this._preview);
            else {
                this._preview = null;
                this._paintDial();
            }
        };
        knob.addEventListener('pointerup', release);
        knob.addEventListener('pointercancel', release);
        knob.addEventListener('keydown', (e) => {
            const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
            if (!d) return;
            e.preventDefault();
            this._nudge(d);
        });
    }

    _paintDial() {
        const st = this._stateObj;
        if (!this._d || !st) return;
        const a = st.attributes;
        const { dial, fill, knob, now, value, status, nowChip } = this._d;
        const { min, max } = this._range();
        const ang = (v) => DIAL.A0 + ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * DIAL.SWEEP;
        const v = this._target();
        const off = st.state === 'off';
        fill.setAttribute('d', dialArc(DIAL.A0, Math.max(ang(v), DIAL.A0 + 0.5)));
        knob.setAttribute('transform', `translate(${dialPt(ang(v)).map((n) => n.toFixed(2)).join(' ')})`);
        knob.setAttribute('aria-valuemin', min);
        knob.setAttribute('aria-valuemax', max);
        knob.setAttribute('aria-valuenow', v);
        knob.setAttribute('aria-valuetext', `${v.toFixed(1)}°`);
        knob.setAttribute('tabindex', off ? '-1' : '0');
        const cur = a.current_temperature;
        const hasCur = cur != null && Number.isFinite(+cur);
        now.style.display = hasCur ? '' : 'none';
        if (hasCur) {
            const [nx, ny] = dialPt(ang(+cur));
            now.setAttribute('cx', nx.toFixed(2));
            now.setAttribute('cy', ny.toFixed(2));
        }
        nowChip.hidden = !hasCur;
        nowChip.textContent = hasCur ? `Now ${(+cur).toFixed(1)}°` : '';
        // colour and text follow what the thermostat is doing: heating, cooling or steady
        const action = a.hvac_action;
        const kind = off ? 'off' : action === 'heating' ? 'heat' : action === 'cooling' ? 'cool' : 'steady';
        dial.dataset.kind = kind;
        value.textContent = off ? 'Off' : `${v.toFixed(1)}°`;
        status.textContent = off ? '' : kind === 'heat' ? 'Heating to' : kind === 'cool' ? 'Cooling to' : 'Steady at';
        status.hidden = off;
    }

    // ------------------------------------------------------------- header

    _renderTop() {
        const st = this._stateObj;
        if (!this._top) return;
        if (!st) {
            this._setHtml(this._top, '_topHtml', '');
            return;
        }
        const a = st.attributes;
        const name = this._config.name || a.friendly_name || this._config.entity;
        const fmtAttr = (attr) => {
            try {
                if (this._hass.formatEntityAttributeValue) return this._hass.formatEntityAttributeValue(st, attr);
            } catch (e) { /* fall through */ }
            const s = String(a[attr] ?? '').replace(/_/g, ' ');
            return s.charAt(0).toUpperCase() + s.slice(1);
        };
        const sub = st.state === 'off' ? 'Off' : a.hvac_action ? fmtAttr('hvac_action') : '';
        const chip = this._infoChips(a);
        this._setHtml(this._top, '_topHtml', `
          <div class="card__head">
            <div class="card__titles">
              <button class="card__title" type="button" data-act="more">${esc(name)}</button>
              ${sub ? `<div class="card__sub">${esc(sub)}</div>` : ''}
            </div>
            ${chip ? `<div class="info">${chip}</div>` : ''}
          </div>`);
    }

    /** The chips in the top-right corner: `info_icons` if set, else the room's humidity. */
    _infoChips(a) {
        const list = this._config.info_icons;
        if (Array.isArray(list)) {
            return list.map((item) => (typeof item === 'string' ? { entity: item } : item || {}))
                .filter((item) => item.entity)
                .map((item) => this._chip(item.entity, item.icon))
                .join('');
        }
        if (a.current_humidity != null && Number.isFinite(+a.current_humidity)) {
            return `<span class="chip" title="Humidity"><ha-icon icon="mdi:water-outline"></ha-icon>${Math.round(+a.current_humidity)}%</span>`;
        }
        const id = this._findHumidity();
        return id ? this._chip(id, 'mdi:water-outline') : '';
    }

    _chip(entityId, icon) {
        const st = this._hass.states[entityId];
        if (!st) return '';
        const dc = st.attributes?.device_class;
        const ico = icon || st.attributes?.icon || CHIP_ICON[dc] || 'mdi:information-outline';
        let value;
        if (dc === 'humidity' && Number.isFinite(+st.state)) value = `${Math.round(+st.state)}%`;
        else {
            try {
                value = this._hass.formatEntityState ? this._hass.formatEntityState(st) : null;
            } catch (e) {
                value = null;
            }
            if (!value) value = `${st.state}${st.attributes?.unit_of_measurement ? ` ${st.attributes.unit_of_measurement}` : ''}`;
        }
        const name = st.attributes?.friendly_name || entityId;
        return `<button type="button" class="chip" data-more="${esc(entityId)}" title="${esc(name)}" aria-label="${esc(`${name}: ${value}`)}"><ha-icon icon="${esc(ico)}"></ha-icon>${esc(value)}</button>`;
    }

    /** A humidity sensor for the chip when none is configured: one on the same device
     *  as a temperature sensor the thermostat uses, else one in the thermostat's area.
     *  Cached until the entity registry changes. */
    _findHumidity() {
        const hass = this._hass;
        const ents = hass.entities || {};
        const key = `${this._config.entity}`;
        if (this._humCache && this._humCache.ents === ents && this._humCache.key === key) return this._humCache.id;
        const isHum = (id) => id.startsWith('sensor.') && hass.states[id]?.attributes?.device_class === 'humidity';
        const list = Object.values(ents);
        let found = null;
        for (const tid of hass.states[this._config.entity]?.attributes?.temperature_sensors || []) {
            const dev = ents[tid]?.device_id;
            const hit = dev && list.find((e) => e.device_id === dev && isHum(e.entity_id));
            if (hit) {
                found = hit.entity_id;
                break;
            }
        }
        if (!found) {
            const me = ents[this._config.entity];
            const area = me?.area_id || (me?.device_id ? hass.devices?.[me.device_id]?.area_id : null);
            if (area) {
                const own = hass.areas?.[area]?.humidity_entity_id;
                found = own && hass.states[own] ? own
                    : list.find((e) => isHum(e.entity_id) && (e.area_id || hass.devices?.[e.device_id]?.area_id) === area)?.entity_id || null;
            }
        }
        this._humCache = { ents, key, id: found };
        return found;
    }

    /** Only touch the DOM when the markup changed: re-rendering on every state
     *  update restarts hover transitions (flicker) and loses focus. */
    _setHtml(el, key, html) {
        if (this[key] === html) return;
        this[key] = html;
        el.innerHTML = html;
    }

    // ------------------------------------------------------------- head

    _fmtWhen(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        const lang = this._hass?.locale?.language || undefined;
        const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
        const today = new Date();
        const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
        if (d.toDateString() === today.toDateString()) return time;
        if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
        return `${d.toLocaleDateString(lang, { weekday: 'short' })} ${time}`;
    }


    _status() {
        const a = this._stateObj.attributes;
        const mode = this._stateObj.state;
        const manual = a.preset_mode === 'manual';
        const fmt = (v) => (v === null || v === undefined ? '–' : `${(+v).toFixed(1)}`);
        let status;
        if (mode === 'off') status = 'Off';
        else if (a.window_open) status = 'Window open · paused';
        else if (manual) status = `Manual · ${fmt(a.manual_temperature)}°`;
        else if (a.override_temperature !== null && a.override_temperature !== undefined) {
            const until = a.override_until ? ` until ${esc(this._fmtWhen(a.override_until))}` : '';
            status = `Override ${fmt(a.override_temperature)}°${until}<a data-act="clear">Back to schedule</a>`;
        } else if (a.slot_end) {
            const temp = a.slot_temperature != null ? ` · ${fmt(a.slot_temperature)}°` : '';
            status = `${esc(a.active_slot || 'Slot')}${temp} · until ${esc(this._fmtWhen(a.slot_end))}`;
        } else if (a.next_slot_start) {
            const next = a.next_slot ? `${esc(a.next_slot)} ` : 'next slot ';
            status = `No slot now · ${next}at ${esc(this._fmtWhen(a.next_slot_start))}`;
        } else status = 'No slots scheduled';
        if (mode === 'heat_cool' && a.cool_above != null && !a.window_open) status += ` · cools above ${fmt(a.cool_above)}°`;
        return status;
    }

    _renderHead() {
        const st = this._stateObj;
        if (!st) {
            this._setHtml(this._head, '_headHtml', `<div class="warn">Entity not found: ${esc(this._config.entity)}</div>`);
            return;
        }
        const a = st.attributes;
        const mode = st.state;
        const manual = a.preset_mode === 'manual';
        const status = this._status();
        const modes = (a.hvac_modes || ['heat', 'off']).filter((m) => MODE_LABEL[m]);
        const canStep = mode !== 'off';
        const color = {
            heat: 'var(--st-heat)',
            cool: 'var(--st-cool)',
            heat_cool: 'var(--state-climate-heat_cool-color, var(--st-ok))',
        }[mode] || 'var(--st-muted)';
        const target = this._target();
        const modeButtons = `<div class="modes" role="group" aria-label="Mode">${modes.map((m) =>
            `<button type="button" class="mode${mode === m ? ' on' : ''}" data-mode="${m}" aria-pressed="${mode === m}"><span class="mode__icon"><ha-icon icon="${MODE_ICON[m]}"></ha-icon></span><span class="mode__label">${MODE_LABEL[m]}</span></button>`).join('')}</div>`;
        const presets = `<div class="presets" role="group" aria-label="Target from" style="--mode-color:${color}">
            <button type="button" data-preset="schedule" class="${!manual ? 'on' : ''}" aria-pressed="${!manual}"><ha-icon icon="mdi:calendar-clock"></ha-icon><span>Schedule</span></button>
            <button type="button" data-preset="manual" class="${manual ? 'on' : ''}" aria-pressed="${manual}"><ha-icon icon="mdi:hand-back-right"></ha-icon><span>Manual</span></button>
          </div>`;
        const stepper = (cls) => `<button type="button" class="round" data-step="-1" aria-label="Lower temperature" ${canStep ? '' : 'disabled'}>−</button>
            ${cls}
            <button type="button" class="round" data-step="1" aria-label="Raise temperature" ${canStep ? '' : 'disabled'}>+</button>`;

        if (this._d) {
            this._setHtml(this._head, '_headHtml', `
              <div class="dialbar">${stepper(`<span class="dialbar__note">${status}</span>`)}</div>
              ${modeButtons}
              ${presets}`);
            return;
        }
        // no dial: the temperatures as text
        const fmt = (v) => (v === null || v === undefined ? '–' : `${(+v).toFixed(1)}`);
        const unit = this._hass.config?.unit_system?.temperature || '°C';
        const action = a.hvac_action;
        const pill = action === 'heating'
            ? '<span class="pill heating"><ha-icon icon="mdi:fire"></ha-icon>Heating</span>'
            : action === 'cooling'
              ? '<span class="pill cooling"><ha-icon icon="mdi:snowflake"></ha-icon>Cooling</span>'
              : `<span class="pill">${mode === 'off' ? 'Off' : 'Idle'}</span>`;
        this._setHtml(this._head, '_headHtml', `
          <div class="temps">
            <span class="cur">${fmt(a.current_temperature)}<span class="small muted">${esc(unit)}</span></span>
            ${target !== null && target !== undefined ? `<span class="target">→ ${fmt(target)}°</span>` : ''}
            ${pill}
          </div>
          <div class="status">${status}</div>
          <div class="dialbar">${stepper(`<span class="setval">${mode === 'off' ? 'Off' : `${fmt(target)}°`}</span>`)}</div>
          ${modeButtons}
          ${presets}`);
    }

    _onHeadClick(e) {
        const el = e.target.closest('[data-mode],[data-preset],[data-step],[data-act]');
        if (!el || el.disabled) return;
        const entity_id = this._config.entity;
        if (el.dataset.mode) {
            this._hass.callService('climate', 'set_hvac_mode', { entity_id, hvac_mode: el.dataset.mode });
        } else if (el.dataset.preset) {
            this._hass.callService('climate', 'set_preset_mode', { entity_id, preset_mode: el.dataset.preset });
        } else if (el.dataset.act === 'clear') {
            this._hass.callService('slot_thermostat', 'clear_override', { entity_id });
        } else if (el.dataset.step) {
            this._nudge(+el.dataset.step);
        }
    }

    // ----------------------------------------------------------- editor

    _renderEditor() {
        if (!this._editor) return;
        if (this._config.show_schedule === false) {
            this._editor.innerHTML = '';
            return;
        }
        if (this._loadState === 'error') {
            this._editor.innerHTML = `<hr><div class="warn">Could not load the schedule: ${esc(this._msg?.text)}</div>`;
            return;
        }
        if (!this._draft) {
            this._editor.innerHTML = this._open ? '<hr><div class="empty">Loading schedule…</div>' : '';
            return;
        }
        const d = this._draft;
        const { min, max, step } = this._limits;
        const rows = this._list
            .map(
                (s, i) => `
          <input data-i="${i}" data-f="title" value="${esc(s.title)}" placeholder="Title" maxlength="60" aria-label="Title">
          <input data-i="${i}" data-f="start" type="time" value="${esc(s.start)}" aria-label="Start">
          <span class="endwrap"><input data-i="${i}" data-f="end" type="time" value="${esc(s.end === '24:00' ? '00:00' : s.end)}" aria-label="End"><span class="plus1" data-plus="${i}"></span></span>
          <input data-i="${i}" data-f="temp" type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}" value="${esc(s.temp)}" aria-label="Temperature">
          <button class="del" data-del="${i}" title="Remove">×</button>`
            )
            .join('');
        const dayName = DAY_NAMES[this._day];
        if (!this._open) {
            const today = DAYS[(new Date().getDay() + 6) % 7];
            const n = (d.mode === 'daily' ? d.daily : d.weekly[today]).length;
            const summary = this._dirty ? 'unsaved changes' : n === 0 ? 'no slots today' : n === 1 ? '1 slot today' : `${n} slots today`;
            this._editor.innerHTML = `
              <button class="toggle" data-act="toggle" aria-expanded="false">
                <ha-icon class="ico" icon="mdi:calendar-clock"></ha-icon><span>Schedule</span><span class="small">· ${summary}</span>
                <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
              </button>`;
            return;
        }
        if (customElements.get('slot-schedule-card')) {
            this._editor.innerHTML = `
              <button class="toggle" data-act="toggle" aria-expanded="true">
                <ha-icon class="ico" icon="mdi:calendar-clock"></ha-icon><span>Schedule</span>
                <ha-icon class="chev" icon="mdi:chevron-up"></ha-icon>
              </button>
              <div class="embedded"></div>`;
            if (!this._schedEl) this._schedEl = document.createElement('slot-schedule-card');
            this._schedEl.setConfig({ entity: this._config.entity, embedded: true, title: '' });
            this._schedEl.hass = this._hass;
            this._editor.querySelector('.embedded').append(this._schedEl);
            return;
        }
        this._editor.innerHTML = `
          <button class="toggle" data-act="toggle" aria-expanded="true">
            <ha-icon class="ico" icon="mdi:calendar-clock"></ha-icon><span>Schedule</span>
            <ha-icon class="chev" icon="mdi:chevron-up"></ha-icon>
          </button>
          <div class="row" style="justify-content:flex-end">
            <div class="seg">
              <button data-smode="daily" class="${d.mode === 'daily' ? 'on' : ''}">Every day</button>
              <button data-smode="weekly" class="${d.mode === 'weekly' ? 'on' : ''}">Per weekday</button>
            </div>
          </div>
          ${
              d.mode === 'weekly'
                  ? `<div class="days">${DAYS.map((day) => `<button data-day="${day}" class="${day === this._day ? 'on' : ''} ${d.weekly[day].length ? 'has' : ''}">${DAY_NAMES[day]}</button>`).join('')}</div>`
                  : ''
          }
          <div class="timeline"></div>
          <div class="ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
          ${
              this._list.length
                  ? `<div class="grid"><span class="h">Title</span><span class="h">Start</span><span class="h">End</span><span class="h">°</span><span></span>${rows}</div>`
                  : `<div class="empty">No slots${d.mode === 'weekly' ? ` on ${dayName}` : ''} — heating and cooling stay off.</div>`
          }
          <button class="link" data-act="add">+ Add slot</button>
          ${
              d.mode === 'weekly'
                  ? `<div class="copy">Copy ${dayName} to: <button class="link" data-copy="weekdays">Weekdays</button><button class="link" data-copy="weekend">Weekend</button><button class="link" data-copy="all">All days</button></div>`
                  : ''
          }
          <div class="foot">
            <span class="msg"></span>
            <button class="btn flat" data-act="revert">Revert</button>
            <button class="btn primary" data-act="save">Save</button>
          </div>`;
        this._refreshState();
    }

    /** Update the parts that depend on the draft without rebuilding the inputs (keeps focus). */
    _refreshState() {
        if (!this._draft || !this._editor.querySelector('.foot')) return;
        this._paintTimeline();
        this._list.forEach((s, i) => {
            const badge = this._editor.querySelector(`[data-plus="${i}"]`);
            if (!badge) return;
            const st = parseTime(s.start);
            const en = parseTime(s.end, true);
            badge.textContent = st !== null && en !== null && en % DAY_MIN <= st && en % DAY_MIN !== 0 ? '+1' : '';
        });
        const error = validate(this._draft, this._limits.min, this._limits.max);
        const msg = this._editor.querySelector('.msg');
        const dirty = this._dirty;
        if (error) {
            msg.className = 'msg err';
            msg.textContent = error;
        } else if (this._msg) {
            msg.className = `msg ${this._msg.err ? 'err' : 'ok'}`;
            msg.textContent = this._msg.text;
        } else {
            msg.className = 'msg muted';
            msg.textContent = dirty ? 'Unsaved changes' : '';
        }
        this._editor.querySelector('[data-act="save"]').disabled = !dirty || !!error || this._saving;
        this._editor.querySelector('[data-act="revert"]').disabled = !dirty || this._saving;
    }

    _paintTimeline() {
        const bar = this._editor?.querySelector('.timeline');
        if (!bar || !this._draft) return;
        const dayIndex = DAYS.indexOf(this._day);
        const blocks = [];
        // Intervals that touch the shown day, including slots running past midnight from the day before.
        for (const iv of weekIntervals(this._draft, this._draft.mode)) {
            for (const shift of [-WEEK_MIN, 0]) {
                const dayStart = (this._draft.mode === 'daily' ? 0 : dayIndex) * DAY_MIN;
                const s = Math.max(iv.start + shift, dayStart);
                const e = Math.min(iv.end + shift, dayStart + DAY_MIN);
                if (e > s) blocks.push({ s: s - dayStart, e: e - dayStart, slot: iv.slot });
            }
        }
        const now = new Date();
        const isToday = this._draft.mode === 'daily' || DAYS[(now.getDay() + 6) % 7] === this._day;
        const nowPct = ((now.getHours() * 60 + now.getMinutes()) / DAY_MIN) * 100;
        bar.innerHTML =
            blocks
                .map((b) => {
                    const t = parseFloat(b.slot.temp);
                    const label = `${b.slot.title ? `${b.slot.title} · ` : ''}${Number.isNaN(t) ? '' : `${t}°`}`;
                    return `<div class="block" title="${esc(label)} (${esc(b.slot.start)}–${esc(b.slot.end)})" style="left:${(b.s / DAY_MIN) * 100}%;width:calc(${((b.e - b.s) / DAY_MIN) * 100}% - 2px);background:${tempColor(t)}">${esc(label)}</div>`;
                })
                .join('') + (isToday ? `<div class="now" style="left:${nowPct}%"></div>` : '');
    }

    _onEditorInput(e) {
        const el = e.target;
        if (el.dataset.i === undefined) return;
        const slot = this._list[+el.dataset.i];
        if (!slot) return;
        const f = el.dataset.f;
        slot[f] = f === 'temp' ? (el.value === '' ? '' : parseFloat(el.value)) : el.value;
        this._msg = null;
        this._refreshState();
    }

    _onEditorClick(e) {
        const el = e.target.closest('button');
        if (!el) return;
        const d = this._draft;
        if (el.dataset.smode) {
            if (d.mode === el.dataset.smode) return;
            // Switching to weekly with an empty week: start every day from the daily slots.
            if (el.dataset.smode === 'weekly' && DAYS.every((day) => !d.weekly[day].length) && d.daily.length) {
                DAYS.forEach((day) => (d.weekly[day] = clone(d.daily)));
            }
            d.mode = el.dataset.smode;
        } else if (el.dataset.day) {
            this._day = el.dataset.day;
        } else if (el.dataset.del !== undefined) {
            this._list.splice(+el.dataset.del, 1);
        } else if (el.dataset.copy) {
            const targets = { weekdays: WEEKDAYS, weekend: WEEKEND, all: DAYS }[el.dataset.copy];
            for (const day of targets) if (day !== this._day) d.weekly[day] = clone(d.weekly[this._day]);
            this._msg = { err: false, text: `Copied ${DAY_NAMES[this._day]} — save to apply` };
        } else if (el.dataset.act === 'add') {
            const list = this._list;
            const sorted = [...list].sort((a, b) => (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0));
            const last = sorted[sorted.length - 1];
            const start = last ? parseTime(last.end, true) % DAY_MIN : 7 * 60;
            const end = Math.min(start + 120, DAY_MIN);
            list.push({ title: '', start: fmtTime(start), end: fmtTime(end), temp: last ? last.temp : 21 });
            this._renderEditor();
            this._editor.querySelector(`[data-i="${list.length - 1}"][data-f="title"]`)?.focus();
            return;
        } else if (el.dataset.act === 'toggle') {
            // Keep the editor open while there are unsaved edits.
            if (this._open && this._dirty) {
                this._msg = { err: true, text: 'Save or revert your changes first' };
                this._refreshState();
                return;
            }
            this._open = !this._open;
            if (!this._open && this._schedEl) {
                this._schedEl.remove();
                this._load();
                return;
            }
        } else if (el.dataset.act === 'revert') {
            this._draft = clone(this._saved);
            this._msg = null;
        } else if (el.dataset.act === 'save') {
            this._save();
            return;
        } else return;
        this._renderEditor();
    }
}

if (!customElements.get('slot-thermostat-card')) {
    customElements.define('slot-thermostat-card', SlotThermostatCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
        type: 'slot-thermostat-card',
        name: 'Slot Thermostat',
        description: 'Thermostat with a schedule of named time slots.',
        documentationURL: 'https://github.com/iamBiB/ha-slot-thermostat',
    });
    console.info(`%c SLOT-THERMOSTAT-CARD %c ${VERSION} `, 'background:#ff7043;color:#fff;border-radius:3px 0 0 3px', 'background:#444;color:#fff;border-radius:0 3px 3px 0');
}
