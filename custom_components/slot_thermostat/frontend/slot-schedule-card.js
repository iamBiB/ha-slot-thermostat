/*
 * Slot Schedule card — bundled with the Slot Thermostat integration.
 * The day's slots on a timeline, with a list to add, edit and delete them.
 * Colours come from the active theme (the Atrium theme gives it its look).
 *
 *   type: custom:slot-schedule-card
 *   entity: climate.living_room
 *   title: Schedule          # optional
 *   show_list: true          # optional, false shows only the timeline
 *   embedded: false          # optional, true drops the card frame (used inside the thermostat card)
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
const todayKey = () => DAYS[(new Date().getDay() + 6) % 7];
const nowMinutes = () => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
};

function parseTime(v, allow24 = false) {
    const m = /^([01]?\d|2[0-4]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(v ?? '').trim());
    if (!m) return null;
    const t = +m[1] * 60 + +m[2];
    if (t > DAY_MIN || (t === DAY_MIN && !allow24)) return null;
    return t;
}
const fmtTime = (t) => (t === DAY_MIN ? '24:00' : `${String(Math.floor((t % DAY_MIN) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
const slotLabel = (s) => s.title || `${s.start}–${s.end}`;

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

/** Icon by the time of day a slot starts. */
function slotIcon(start) {
    const h = Math.floor(start / 60);
    if (h >= 5 && h < 11) return 'mdi:weather-sunny';
    if (h >= 11 && h < 17) return 'mdi:leaf';
    if (h >= 17 && h < 22) return 'mdi:sofa-outline';
    return 'mdi:weather-night';
}

/** Slot colour: from the cool colour (16° and below) to the heat colour (23° and up). */
const slotColor = (t) => {
    const p = Math.max(0, Math.min(100, Math.round((Number(t) - 16) * 14)));
    return `color-mix(in srgb, var(--sched-heat) ${p}%, var(--sched-cool))`;
};

const CSS = `
:host {
  display: block;
  --sched-text: var(--primary-text-color);
  --sched-muted: var(--secondary-text-color);
  --sched-fill: color-mix(in srgb, var(--primary-text-color) 5.5%, transparent);
  --sched-fill-strong: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
  --sched-line: var(--divider-color);
  --sched-accent: var(--primary-color);
  --sched-on-accent: var(--text-primary-color, #fff);
  --sched-heat: var(--state-climate-heat-color, #ff9f5a);
  --sched-cool: var(--state-climate-cool-color, var(--primary-color));
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
button:disabled { cursor: default; }
:focus-visible { outline: 2px solid var(--sched-accent); outline-offset: 2px; }
.frame { display: block; padding: 20px; color: var(--sched-text); }
.frame.embedded { padding: 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.title { font-size: 16px; font-weight: 600; margin: 0; }
.sub { font-size: 13px; color: var(--sched-muted); margin-top: 2px; }
.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.seg { display: inline-flex; gap: 2px; padding: 4px; border-radius: 999px; background: var(--sched-fill); border: 1px solid var(--sched-line); flex-wrap: wrap; }
.seg button { padding: 7px 12px; border-radius: 999px; font-size: 13px; font-weight: 500; color: var(--sched-muted); transition: background .18s, color .18s; }
.seg button:hover { color: var(--sched-text); }
.seg button[aria-pressed="true"] { background: var(--sched-fill-strong); color: var(--sched-text); }
.seg button.has-slots::after { content: ""; display: inline-block; width: 4px; height: 4px; margin-left: 5px; vertical-align: middle; border-radius: 50%; background: currentColor; opacity: .5; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 9px 16px; border-radius: 999px; background: var(--sched-fill-strong); font-size: 13px; font-weight: 600; white-space: nowrap; transition: background .18s, opacity .18s; --mdc-icon-size: 16px; }
.btn--primary { background: var(--sched-accent); color: var(--sched-on-accent); }
.btn--ghost { background: none; color: var(--sched-muted); padding: 9px 10px; }
.btn--ghost:hover { color: var(--sched-text); }
.btn--danger { background: color-mix(in srgb, var(--error-color, #ff7272) 16%, transparent); color: var(--error-color, #ff7272); }
.btn:disabled { opacity: .45; }

.track { position: relative; height: 60px; border-radius: 18px; background: var(--sched-fill); border: 1px solid var(--sched-line); overflow: hidden; }
.slot {
  position: absolute; top: 5px; bottom: 5px; min-width: 6px;
  display: grid; place-items: center; overflow: hidden; white-space: nowrap;
  border-radius: 13px; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums;
  color: #0e1116; transition: filter .18s, box-shadow .18s;
}
.slot:hover { filter: brightness(1.08); }
.slot.is-active { box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .6); }
.now { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--sched-text); box-shadow: 0 0 0 3px color-mix(in srgb, var(--sched-text) 18%, transparent); pointer-events: none; }
.hours { display: flex; justify-content: space-between; margin: 8px 0 18px; font-size: 11.5px; color: var(--sched-muted); font-variant-numeric: tabular-nums; }
.hours.is-last { margin-bottom: 0; }

.rows { list-style: none; margin: 0; padding: 0; }
.rows > li { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--sched-line); }
.rows > li:first-child { border-top: 0; padding-top: 0; }
.rows > li:last-child { padding-bottom: 0; }
.row__icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--sched-fill-strong); color: var(--sched-muted); flex: none; --mdc-icon-size: 20px; transition: background .2s, color .2s; }
li.is-active .row__icon { background: var(--sched-accent); color: var(--sched-on-accent); }
.row__main { flex: 1; min-width: 0; }
.row__title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row__meta { font-size: 12.5px; color: var(--sched-muted); font-variant-numeric: tabular-nums; }
.row__value { font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.empty { color: var(--sched-muted); font-size: 14px; padding: 4px 0; }

li.is-editing { flex-wrap: wrap; align-items: flex-start; }
.form { flex-basis: 100%; display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px; align-items: end; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12px; color: var(--sched-muted); }
.field input {
  font: inherit; font-size: 14px; color: var(--sched-text); min-width: 0;
  background: var(--sched-fill); border: 1px solid var(--sched-line); border-radius: 12px; padding: 8px 10px;
  color-scheme: light dark;
}
.field input:focus { outline: 2px solid var(--sched-accent); outline-offset: -1px; }
.stepper { display: inline-flex; align-items: center; gap: 6px; height: 38px; }
.icon-btn { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--sched-fill); border: 1px solid var(--sched-line); font-size: 18px; line-height: 1; }
.icon-btn:hover { background: var(--sched-fill-strong); }
.stepper__value { min-width: 48px; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
.form__foot { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.spacer { flex: 1; }

.msg { font-size: 13px; }
.msg.err { color: var(--error-color, #ff7272); }
.msg.ok { color: var(--success-color, #43a047); }
.foot { display: flex; align-items: center; gap: 8px 14px; flex-wrap: wrap; margin-top: 16px; font-size: 13px; color: var(--sched-muted); }
.foot:empty { display: none; }
.link { color: var(--sched-accent); font-size: 13px; padding: 2px 0; }
.link:hover { text-decoration: underline; }
.warn { color: var(--error-color, #ff7272); font-size: 14px; }

@media (max-width: 560px) {
  .form { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .field--title, .field--temp { grid-column: 1 / -1; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; }
}
`;

class SlotScheduleCard extends HTMLElement {
    static getStubConfig(hass) {
        const ents = hass?.entities || {};
        const entity = Object.keys(ents).find((id) => ents[id].platform === 'slot_thermostat' && id.startsWith('climate.')) || '';
        return { entity };
    }

    static getConfigForm() {
        return {
            schema: [
                { name: 'entity', required: true, selector: { entity: { domain: 'climate', integration: 'slot_thermostat' } } },
                { name: 'title', selector: { text: {} } },
                { name: 'show_list', default: true, selector: { boolean: {} } },
            ],
            computeLabel: (s) => ({ entity: 'Slot thermostat', title: 'Title', show_list: 'Show the list of slots' })[s.name],
            computeHelper: (s) => (s.name === 'show_list' ? 'Off shows only the timeline. Tap a slot on it to edit.' : undefined),
        };
    }

    setConfig(config) {
        if (!config || !config.entity) throw new Error('Set `entity` to a Slot Thermostat climate entity');
        const changed = this._config && this._config.entity !== config.entity;
        this._config = { show_list: true, ...config };
        if (changed) {
            this._schedule = null;
            this._loadState = 'idle';
            this._edit = null;
        }
        if (this._root) this._render();
    }

    getCardSize() {
        return this._config?.show_list === false ? 3 : 7;
    }

    getGridOptions() {
        return { columns: 12, min_columns: 6, rows: 'auto' };
    }

    set hass(hass) {
        const prev = this._hass;
        this._hass = hass;
        if (!this._root) this._build();
        if (this._loadState === 'idle' || this._loadState === undefined) {
            this._load();
            return;
        }
        // The current or next slot changed (another client edited the schedule, or
        // time moved on): refresh, unless the user is in the middle of an edit.
        const a = prev?.states[this._config.entity]?.attributes;
        const b = hass.states[this._config.entity]?.attributes;
        if (a && b && (a.slot_start !== b.slot_start || a.next_slot !== b.next_slot || a.next_slot_start !== b.next_slot_start)) {
            this._reload();
        }
    }

    connectedCallback() {
        clearInterval(this._tick);
        // Move the "now" line and the current slot every minute; reload every 5 minutes.
        this._tick = setInterval(() => {
            this._minutes = (this._minutes || 0) + 1;
            if (this._minutes % 5 === 0) this._reload();
            else if (!this._edit && this._root) this._render();
        }, 60000);
    }

    disconnectedCallback() {
        clearInterval(this._tick);
        clearTimeout(this._msgTimer);
    }

    _build() {
        this._root = this.attachShadow({ mode: 'open' });
        this._root.innerHTML = this._config?.embedded
            ? `<style>${CSS}</style><div class="frame embedded"><div class="body"></div></div>`
            : `<style>${CSS}</style><ha-card class="frame"><div class="body"></div></ha-card>`;
        this._body = this._root.querySelector('.body');
        this._day = todayKey();
        this._body.addEventListener('click', (e) => this._onClick(e));
        this._body.addEventListener('input', (e) => this._onInput(e));
        this._body.addEventListener('keydown', (e) => {
            if (!this._edit) return;
            if (e.key === 'Escape') {
                this._edit = null;
                this._render();
            } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
                e.preventDefault();
                this._saveEdit();
            }
        });
        this._render();
    }

    // ------------------------------------------------------------- data

    async _load() {
        if (!this._hass || !this._config) return;
        this._loadState = 'loading';
        try {
            const res = await this._hass.callWS({ type: 'slot_thermostat/schedule/get', entity_id: this._config.entity });
            this._limits = { min: res.min_temp, max: res.max_temp, step: res.step || 0.5 };
            this._schedule = res.schedule;
            this._loadState = 'loaded';
        } catch (err) {
            this._loadState = 'error';
            this._error = err?.message || String(err);
        }
        this._render();
    }

    _reload() {
        if (this._edit || this._busy || this._loadState === 'loading') return;
        if (Date.now() - (this._lastReload || 0) < 5000) return;
        this._lastReload = Date.now();
        this._load();
    }

    /** Validate and store a whole new schedule. Returns true when saved. */
    async _save(next, okText) {
        const error = validate(next, this._limits.min, this._limits.max);
        if (error) {
            this._flash(error, true);
            return false;
        }
        this._busy = true;
        this._render();
        let ok = false;
        try {
            const res = await this._hass.callWS({ type: 'slot_thermostat/schedule/set', entity_id: this._config.entity, schedule: next });
            this._schedule = res.schedule;
            ok = true;
        } catch (err) {
            this._flash(err?.message || String(err), true);
        }
        this._busy = false;
        if (ok) {
            this._edit = null;
            this._flash(okText || 'Saved', false);
        } else {
            this._render();
        }
        return ok;
    }

    _flash(text, err) {
        this._msg = { text, err };
        clearTimeout(this._msgTimer);
        if (!err) {
            this._msgTimer = setTimeout(() => {
                this._msg = null;
                this._render();
            }, 2500);
        }
        this._render();
    }

    _listOf(schedule, day = this._day) {
        return schedule.mode === 'daily' ? schedule.daily : schedule.weekly[day];
    }

    get _isToday() {
        return this._schedule?.mode === 'daily' || this._day === todayKey();
    }

    // ------------------------------------------------------------- view model

    /** Slots of the shown day as minutes (end > start; past midnight runs over 1440),
     *  plus the tails of slots that started the day before and run past midnight. */
    _view() {
        const s = this._schedule;
        const list = this._listOf(s);
        const items = list.map((slot, i) => {
            const start = parseTime(slot.start) ?? 0;
            let end = parseTime(slot.end, true) ?? start;
            end %= DAY_MIN;
            if (end <= start) end += DAY_MIN;
            return { slot, i, start, end };
        }).sort((a, b) => a.start - b.start);
        const prevDay = DAYS[(DAYS.indexOf(this._day) + 6) % 7];
        const prevList = s.mode === 'daily' ? s.daily : s.weekly[prevDay];
        const tails = [];
        for (const slot of prevList) {
            const start = parseTime(slot.start);
            const end = parseTime(slot.end, true);
            if (start === null || end === null) continue;
            if (end % DAY_MIN !== 0 && end < start) tails.push({ slot, start: 0, end, tail: true });
        }
        const now = this._isToday ? nowMinutes() : null;
        const isActive = (it) => now !== null && now >= it.start && now < Math.min(it.end, DAY_MIN);
        items.forEach((it) => (it.active = isActive(it)));
        tails.forEach((it) => (it.active = isActive(it)));
        return { items, tails, now };
    }

    _fmtTemp(t) {
        const n = Number(t);
        const lang = this._hass?.locale?.language;
        try {
            return `${n.toLocaleString(lang, { maximumFractionDigits: 1 })}°`;
        } catch (e) {
            return `${n}°`;
        }
    }

    _span(item) {
        const end = item.end >= DAY_MIN && item.end % DAY_MIN !== 0 ? `${fmtTime(item.end % DAY_MIN)} (+1)` : fmtTime(Math.min(item.end, DAY_MIN));
        return `${fmtTime(item.start)} to ${end}`;
    }

    // ------------------------------------------------------------- render

    _render() {
        if (!this._body || !this._config) return;
        const st = this._hass?.states[this._config.entity];
        const name = this._config.name || st?.attributes?.friendly_name || this._config.entity;
        const title = this._config.title ?? 'Schedule';

        if (this._loadState !== 'loaded' || !this._schedule) {
            const text = this._loadState === 'error'
                ? `<p class="warn">Couldn't load the schedule: ${esc(this._error)}. Is ${esc(this._config.entity)} a Slot Thermostat?</p>`
                : '<p class="sub">Loading…</p>';
            this._body.innerHTML = `<div class="head"><div>${title ? `<h2 class="title">${esc(title)}</h2> ` : ''}<p class="sub">${esc(name)}</p></div></div>${text}`;
            return;
        }

        const s = this._schedule;
        const daily = s.mode === 'daily';
        const { items, tails, now } = this._view();
        const count = items.length;
        const when = daily ? 'Every day' : this._day === todayKey() ? `${DAY_NAMES[this._day]} (today)` : DAY_NAMES[this._day];
        const sub = `${name} · ${when} · ${count ? `${count} slot${count === 1 ? '' : 's'}` : 'no slots, heating and cooling stay off'}`;
        const busy = this._busy ? ' disabled' : '';

        const days = daily ? '' : `<div class="seg" role="group" aria-label="Day">${DAYS.map((d) =>
            `<button type="button" data-act="day" data-day="${d}" aria-pressed="${d === this._day}"${s.weekly[d].length ? ' class="has-slots"' : ''}>${DAY_NAMES[d]}</button>`).join('')}</div>`;
        const add = this._config.show_list === false ? ''
            : `<button class="btn btn--primary" type="button" data-act="add"${busy || (this._edit ? ' disabled' : '')}><ha-icon icon="mdi:plus"></ha-icon>Add slot</button>`;

        const block = (it) => {
            const left = (it.start / DAY_MIN) * 100;
            const width = ((Math.min(it.end, DAY_MIN) - it.start) / DAY_MIN) * 100;
            const label = this._fmtTemp(it.slot.temp);
            const aria = `${slotLabel(it.slot)}, ${this._span(it)}, ${label}`;
            return `<button type="button" class="slot${it.active ? ' is-active' : ''}" data-act="${it.tail ? 'noop' : 'edit'}" data-i="${it.tail ? '' : it.i}"
                style="left:calc(${left}% + 2px);width:calc(${width}% - 4px);background:${slotColor(it.slot.temp)}" title="${esc(aria)}" aria-label="${esc(aria)}"${it.tail ? ' tabindex="-1"' : ''}>${width > 4 ? esc(label) : ''}</button>`;
        };
        const nowLine = now !== null ? `<span class="now" style="left:${(now / DAY_MIN) * 100}%"></span>` : '';
        const listOn = this._config.show_list !== false;
        const track = `<div class="track">${tails.map(block).join('')}${items.map(block).join('')}${nowLine}</div>
          <div class="hours${listOn || this._edit ? '' : ' is-last'}"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>`;

        let rows = '';
        if (listOn || this._edit) {
            const shown = listOn ? items : [];
            const lis = shown.map((it) => (this._edit && this._edit.i === it.i ? this._formRow() : `
              <li class="${it.active ? 'is-active' : ''}">
                <span class="row__icon"><ha-icon icon="${slotIcon(it.start)}"></ha-icon></span>
                <div class="row__main">
                  <div class="row__title">${esc(it.slot.title || 'Slot')}</div>
                  <div class="row__meta">${esc(this._span(it))}</div>
                </div>
                <span class="row__value">${esc(this._fmtTemp(it.slot.temp))}</span>
                <button class="btn btn--ghost" type="button" data-act="edit" data-i="${it.i}"${busy || (this._edit ? ' disabled' : '')}>Edit</button>
              </li>`));
            if (this._edit && (this._edit.i === -1 || !listOn)) lis.push(this._formRow());
            rows = lis.length ? `<ul class="rows">${lis.join('')}</ul>`
                : '<p class="empty">No slots yet. Add one to start heating or cooling on a schedule.</p>';
        }

        // footer: every day / per weekday, copy the shown day, messages
        let foot = '';
        if (listOn) {
            const mode = `<div class="seg" role="group" aria-label="Schedule type">
                <button type="button" data-act="mode" data-mode="daily" aria-pressed="${daily}"${busy}>Every day</button>
                <button type="button" data-act="mode" data-mode="weekly" aria-pressed="${!daily}"${busy}>Per weekday</button></div>`;
            const copy = daily ? '' : `<span>Copy ${DAY_NAMES[this._day]} to</span>
                <button class="link" type="button" data-act="copy" data-to="weekdays"${busy}>weekdays</button>
                <button class="link" type="button" data-act="copy" data-to="weekend"${busy}>weekend</button>
                <button class="link" type="button" data-act="copy" data-to="all"${busy}>all days</button>`;
            foot = `${mode}${copy}`;
        }
        if (this._msg && !this._edit) foot += `<span class="msg ${this._msg.err ? 'err' : 'ok'}" role="status">${esc(this._msg.text)}</span>`;

        this._body.innerHTML = `
          <div class="head">
            <div>${title ? `<h2 class="title">${esc(title)}</h2> ` : ''}<p class="sub">${esc(sub)}</p></div>
            <div class="actions">${days}${add}</div>
          </div>
          ${track}
          ${rows}
          <div class="foot">${foot}</div>`;

        if (this._edit && this._focusEdit) {
            this._focusEdit = false;
            this._body.querySelector('.form input')?.focus();
        }
    }

    _formRow() {
        const e = this._edit;
        const isNew = e.i === -1;
        const start = parseTime(e.start) ?? 0;
        const busy = this._busy ? ' disabled' : '';
        // <input type="time"> can't show 24:00; 23:59 means "until midnight" (as in schedule.py)
        const endValue = e.end === '24:00' ? '23:59' : e.end;
        const msg = this._msg ? `<span class="msg ${this._msg.err ? 'err' : 'ok'}" role="status">${esc(this._msg.text)}</span>` : '';
        return `
          <li class="is-editing">
            <span class="row__icon"><ha-icon icon="${slotIcon(start)}"></ha-icon></span>
            <div class="row__main">
              <div class="row__title">${isNew ? 'New slot' : esc(e.title || 'Slot')}</div>
              <div class="row__meta">An end before the start runs past midnight.</div></div>
            <div class="form">
              <label class="field field--title">Title<input type="text" data-f="title" value="${esc(e.title)}" maxlength="60" placeholder="Morning"></label>
              <label class="field">Start<input type="time" data-f="start" value="${esc(e.start)}" required></label>
              <label class="field">End<input type="time" data-f="end" value="${esc(endValue)}" required></label>
              <div class="field field--temp">Temperature
                <div class="stepper">
                  <button class="icon-btn" type="button" data-act="temp" data-dir="-1" aria-label="Lower">−</button>
                  <span class="stepper__value" aria-live="polite">${esc(this._fmtTemp(e.temp))}</span>
                  <button class="icon-btn" type="button" data-act="temp" data-dir="1" aria-label="Raise">+</button>
                </div>
              </div>
              <div class="form__foot">
                ${isNew ? '' : `<button class="btn btn--danger" type="button" data-act="delete"${busy}>Delete</button>`}
                ${msg}
                <span class="spacer"></span>
                <button class="btn btn--ghost" type="button" data-act="cancel">Cancel</button>
                <button class="btn btn--primary" type="button" data-act="save"${busy}>${isNew ? 'Add' : 'Save'}</button>
              </div>
            </div>
          </li>`;
    }

    // ------------------------------------------------------------- actions

    _onInput(e) {
        const f = e.target.dataset?.f;
        if (!f || !this._edit) return;
        this._edit[f] = e.target.value;
    }

    _onClick(e) {
        const el = e.target.closest('[data-act]');
        if (!el || el.disabled || !this._schedule) return;
        const act = el.dataset.act;
        const list = this._listOf(this._schedule);

        if (act === 'day') {
            this._day = el.dataset.day;
            this._edit = null;
            this._msg = null;
            this._render();
        } else if (act === 'add') {
            const sorted = [...list].sort((a, b) => (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0));
            const last = sorted[sorted.length - 1];
            const start = last ? (parseTime(last.end, true) ?? 0) % DAY_MIN : 7 * 60;
            const end = Math.min(start + 120, DAY_MIN);
            this._edit = { i: -1, title: '', start: fmtTime(start), end: fmtTime(end), temp: last ? Number(last.temp) : 21 };
            this._msg = null;
            this._focusEdit = true;
            this._render();
        } else if (act === 'edit') {
            const i = Number(el.dataset.i);
            if (!list[i]) return;
            this._edit = { i, ...clone(list[i]) };
            this._msg = null;
            this._focusEdit = true;
            this._render();
        } else if (act === 'cancel') {
            this._edit = null;
            this._msg = null;
            this._render();
        } else if (act === 'temp' && this._edit) {
            const { min, max, step } = this._limits;
            const v = Math.round((Number(this._edit.temp) + Number(el.dataset.dir) * step) / step) * step;
            this._edit.temp = Math.min(max, Math.max(min, Number(v.toFixed(2))));
            const out = this._body.querySelector('.stepper__value');
            if (out) out.textContent = this._fmtTemp(this._edit.temp);
        } else if (act === 'save') {
            this._saveEdit();
        } else if (act === 'delete' && this._edit) {
            const next = clone(this._schedule);
            const label = slotLabel(this._listOf(next)[this._edit.i] || {});
            this._listOf(next).splice(this._edit.i, 1);
            this._save(next, `Deleted ${label}`);
        } else if (act === 'mode') {
            const mode = el.dataset.mode;
            if (mode === this._schedule.mode) return;
            const next = clone(this._schedule);
            next.mode = mode;
            // switching for the first time: start from what's there
            if (mode === 'weekly' && DAYS.every((d) => !next.weekly[d].length)) DAYS.forEach((d) => (next.weekly[d] = clone(next.daily)));
            if (mode === 'daily' && !next.daily.length) next.daily = clone(next.weekly[this._day]);
            this._edit = null;
            this._save(next, mode === 'daily' ? 'Now the same every day' : 'Now per weekday');
        } else if (act === 'copy') {
            const targets = { weekdays: WEEKDAYS, weekend: WEEKEND, all: DAYS }[el.dataset.to] || [];
            const next = clone(this._schedule);
            const src = next.weekly[this._day];
            targets.forEach((d) => {
                if (d !== this._day) next.weekly[d] = clone(src);
            });
            this._save(next, `Copied ${DAY_NAMES[this._day]} to ${el.dataset.to === 'all' ? 'all days' : el.dataset.to}`);
        }
    }

    _saveEdit() {
        const e = this._edit;
        if (!e) return;
        const slot = { title: String(e.title || '').trim(), start: e.start, end: e.end === '23:59' ? '24:00' : e.end, temp: Number(e.temp) };
        const next = clone(this._schedule);
        const list = this._listOf(next);
        if (e.i === -1) list.push(slot);
        else list[e.i] = slot;
        this._save(next, e.i === -1 ? `Added ${slotLabel(slot)}` : `Saved ${slotLabel(slot)}`);
    }
}

if (!customElements.get('slot-schedule-card')) {
    customElements.define('slot-schedule-card', SlotScheduleCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
        type: 'slot-schedule-card',
        name: 'Slot Schedule',
        description: 'A Slot Thermostat schedule on a day timeline, with slots to add, edit and delete.',
        documentationURL: 'https://github.com/iamBiB/ha-slot-thermostat',
    });
    console.info(`%c SLOT-SCHEDULE-CARD %c ${VERSION} `, 'background:#ff7043;color:#fff;border-radius:3px 0 0 3px', 'background:#444;color:#fff;border-radius:0 3px 3px 0');
}
