/*
 * Slot Thermostat card — bundled with the Slot Thermostat integration.
 * Shows the thermostat and edits its schedule: named slots with start, end
 * and temperature, daily or per weekday.
 *
 *   type: custom:slot-thermostat-card
 *   entity: climate.living_room
 *   name: Living room        # optional
 *   show_schedule: true      # optional, false hides the editor
 */
const VERSION = '0.1.1';
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

const CSS = `
:host { display: block; }
ha-card { padding: 16px; overflow: hidden; }
.row { display: flex; align-items: center; gap: 8px; }
.between { justify-content: space-between; }
.name { font-size: 18px; font-weight: 500; }
.muted { color: var(--secondary-text-color); }
.small { font-size: 12px; }
.temps { display: flex; align-items: baseline; gap: 10px; margin: 6px 0 2px; }
.cur { font-size: 40px; font-weight: 300; line-height: 1; }
.target { font-size: 18px; color: var(--secondary-text-color); }
.pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); display: inline-flex; align-items: center; gap: 4px; }
.pill.heating { background: color-mix(in srgb, #ff7043 22%, transparent); color: #ff7043; }
.pill.cooling { background: color-mix(in srgb, #29b6f6 22%, transparent); color: #29b6f6; }
.status { margin: 6px 0 12px; font-size: 14px; }
.status.center { text-align: center; margin: 10px 0 0; }
.presets { display: flex; gap: 0; height: 42px; border-radius: 12px; overflow: hidden; background: color-mix(in srgb, var(--primary-text-color) 10%, transparent); margin: 0 -4px; }
.presets button { flex: 1 1 0; border: 0; background: none; color: var(--primary-text-color); font: inherit; font-size: 14px; display: flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer; border-radius: 12px; --mdc-icon-size: 20px; }
.presets button.on { background: var(--mode-color); color: #fff; }
.dial { margin: -16px -16px 0; }
.status a { color: var(--primary-color); cursor: pointer; text-decoration: none; margin-left: 6px; }
.controls { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.seg { display: inline-flex; border: 1px solid var(--divider-color); border-radius: 10px; overflow: hidden; }
.seg button { border: 0; background: none; color: var(--primary-text-color); padding: 7px 14px; font: inherit; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--divider-color); }
.seg button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
.stepper { display: inline-flex; align-items: center; gap: 6px; }
.round { width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--divider-color); background: none; color: var(--primary-text-color); font-size: 20px; cursor: pointer; line-height: 1; }
.round:disabled { opacity: .35; cursor: default; }
.setval { min-width: 56px; text-align: center; font-size: 18px; }
hr { border: 0; border-top: 1px solid var(--divider-color); margin: 16px 0; }
.toggle { width: 100%; display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 10px 4px; border: 0; border-top: 1px solid var(--divider-color); background: none; color: var(--primary-text-color); font: inherit; font-size: 15px; cursor: pointer; text-align: left; --mdc-icon-size: 20px; }
.toggle .chev { margin-left: auto; color: var(--secondary-text-color); }
.days { display: flex; gap: 4px; flex-wrap: wrap; margin: 10px 0; }
.days button { flex: 1 1 0; min-width: 40px; border: 1px solid var(--divider-color); background: none; color: var(--primary-text-color); border-radius: 8px; padding: 6px 0; font: inherit; font-size: 13px; cursor: pointer; position: relative; }
.days button.on { border-color: var(--primary-color); color: var(--primary-color); font-weight: 600; }
.days button.has::after { content: ''; position: absolute; left: 50%; bottom: 2px; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: currentColor; opacity: .6; }
.timeline { position: relative; height: 26px; border-radius: 6px; background: var(--secondary-background-color); margin: 8px 0 2px; overflow: hidden; }
.block { position: absolute; top: 0; bottom: 0; border-radius: 4px; font-size: 11px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 4px; line-height: 26px; box-sizing: border-box; }
.now { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--primary-text-color); opacity: .7; }
.ticks { display: flex; justify-content: space-between; font-size: 10px; color: var(--secondary-text-color); margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 92px 92px 74px 32px; gap: 6px; align-items: center; }
.grid .h { font-size: 12px; color: var(--secondary-text-color); }
.grid input { width: 100%; box-sizing: border-box; font: inherit; font-size: 14px; padding: 7px 8px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--card-background-color, var(--ha-card-background)); color: var(--primary-text-color); color-scheme: light dark; }
.grid input:focus { outline: 2px solid var(--primary-color); outline-offset: -1px; }
.endwrap { position: relative; }
.plus1 { position: absolute; right: 26px; top: 50%; transform: translateY(-50%); font-size: 10px; color: var(--secondary-text-color); pointer-events: none; }
.del { width: 32px; height: 32px; border: 0; background: none; color: var(--secondary-text-color); cursor: pointer; font-size: 18px; border-radius: 50%; }
.del:hover { color: var(--error-color); background: var(--secondary-background-color); }
.empty { padding: 12px 0; text-align: center; color: var(--secondary-text-color); font-size: 14px; }
.link { border: 0; background: none; color: var(--primary-color); font: inherit; font-size: 14px; cursor: pointer; padding: 6px 0; }
.copy { font-size: 13px; color: var(--secondary-text-color); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.copy .link { font-size: 13px; padding: 2px 0; }
.foot { display: flex; align-items: center; gap: 10px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
.msg { flex: 1 1 auto; font-size: 13px; }
.msg.err { color: var(--error-color); }
.msg.ok { color: var(--success-color, #43a047); }
.btn { border: 0; border-radius: 10px; padding: 8px 16px; font: inherit; cursor: pointer; }
.btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
.btn.flat { background: none; color: var(--primary-text-color); border: 1px solid var(--divider-color); }
.btn:disabled { opacity: .4; cursor: default; }
.warn { color: var(--error-color); padding: 8px 0; font-size: 14px; }
@media (max-width: 480px) {
  .grid { grid-template-columns: minmax(0, 1fr) 80px 80px 64px 28px; gap: 4px; }
  .grid input { padding: 6px 4px; font-size: 13px; }
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
        if (this._dial) this._dial.setConfig(this._dialConfig());
        if (this._root) this._renderEditor();
    }

    /** Config for Home Assistant's own thermostat card, embedded at the top. */
    _dialConfig() {
        const modes = this._hass?.states[this._config.entity]?.attributes.hvac_modes || ['heat', 'off'];
        return {
            type: 'thermostat',
            entity: this._config.entity,
            ...(this._config.name ? { name: this._config.name } : {}),
            features: [
                { type: 'climate-hvac-modes', hvac_modes: modes },
            ],
        };
    }

    /** Remove the embedded card's own frame, even when a theme styles ha-card directly. */
    async _flattenDial(attempt = 0) {
        const el = this._dial;
        if (!el) return;
        if (el.updateComplete) await el.updateComplete.catch(() => {});
        const inner = el.shadowRoot?.querySelector('ha-card');
        if (!inner) {
            if (attempt < 20) setTimeout(() => this._flattenDial(attempt + 1), 100);
            return;
        }
        for (const [prop, value] of [
            ['background', 'none'],
            ['border', 'none'],
            ['box-shadow', 'none'],
            ['backdrop-filter', 'none'],
            ['-webkit-backdrop-filter', 'none'],
        ]) inner.style.setProperty(prop, value, 'important');
    }

    async _makeDial() {
        if (this._config.dial === false || typeof window.loadCardHelpers !== 'function') return;
        try {
            const helpers = await window.loadCardHelpers();
            const el = helpers.createCardElement(this._dialConfig());
            el.hass = this._hass;
            // Blend the embedded card into ours: no second frame.
            el.style.setProperty('--ha-card-background', 'transparent');
            el.style.setProperty('--ha-card-box-shadow', 'none');
            el.style.setProperty('--ha-card-border-width', '0');
            this._dialWrap.appendChild(el);
            this._dial = el;
            this._flattenDial();
            this._renderHead();
        } catch (err) {
            console.warn('slot-thermostat-card: built-in thermostat card unavailable, using the simple header', err);
        }
    }

    getCardSize() {
        return this._config?.show_schedule === false ? 3 : 9;
    }

    getGridOptions() {
        return { columns: 12, min_columns: 6, rows: 'auto' };
    }

    set hass(hass) {
        this._hass = hass;
        if (!this._root) this._build();
        if (this._dial) this._dial.hass = hass;
        else if (!this._dialRequested) {
            this._dialRequested = true;
            this._makeDial();
        }
        this._renderHead();
        if (this._config.show_schedule !== false && this._loadState === 'idle') this._load();
        if (this._draft) this._paintTimeline();
    }

    get _stateObj() {
        return this._hass?.states[this._config.entity];
    }

    _build() {
        this._root = this.attachShadow({ mode: 'open' });
        this._root.innerHTML = `<style>${CSS}</style><ha-card><div class="dial"></div><div class="head"></div><div class="editor"></div></ha-card>`;
        this._dialWrap = this._root.querySelector('.dial');
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

    _renderHead() {
        const st = this._stateObj;
        if (!st) {
            this._head.innerHTML = `<div class="warn">Entity not found: ${esc(this._config.entity)}</div>`;
            return;
        }
        const a = st.attributes;
        const unit = this._hass.config?.unit_system?.temperature || '°C';
        const mode = st.state;
        const action = a.hvac_action;
        const target = this._pending ?? a.temperature;
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

        const pill =
            action === 'heating'
                ? '<span class="pill heating">🔥 Heating</span>'
                : action === 'cooling'
                  ? '<span class="pill cooling">❄️ Cooling</span>'
                  : `<span class="pill">${mode === 'off' ? 'Off' : 'Idle'}</span>`;
        const modes = a.hvac_modes || ['heat', 'off'];
        const labels = { heat: 'Heat', cool: 'Cool', heat_cool: 'Heat/Cool', off: 'Off' };
        const canStep = mode !== 'off';
        if (this._dial) {
            // The embedded dial shows temperatures, action and modes; we add the schedule status.
            const color = {
                heat: 'var(--state-climate-heat-color, #ff8100)',
                cool: 'var(--state-climate-cool-color, #2b9af9)',
                heat_cool: 'var(--state-climate-heat_cool-color, #008000)',
            }[mode] || 'var(--state-climate-off-color, #8a8a8a)';
            this._head.innerHTML = `
              <div class="presets" style="--mode-color:${color}">
                <button data-preset="schedule" class="${!manual ? 'on' : ''}"><ha-icon icon="mdi:calendar-clock"></ha-icon><span>Schedule</span></button>
                <button data-preset="manual" class="${manual ? 'on' : ''}"><ha-icon icon="mdi:hand-back-right"></ha-icon><span>Manual</span></button>
              </div>
              <div class="status muted center">${status}</div>`;
            return;
        }
        const name = this._config.name || a.friendly_name || this._config.entity;
        this._head.innerHTML = `
          <div class="row between">
            <div class="name">${esc(name)}</div>
            ${pill}
          </div>
          <div class="temps">
            <span class="cur">${fmt(a.current_temperature)}<span class="small muted">${esc(unit)}</span></span>
            ${target !== null && target !== undefined ? `<span class="target">→ ${fmt(target)}°</span>` : ''}
          </div>
          <div class="status muted">${status}</div>
          <div class="controls">
            <div class="seg">
              ${modes.filter((m) => labels[m]).map((m) => `<button data-mode="${m}" class="${mode === m ? 'on' : ''}">${labels[m]}</button>`).join('')}
            </div>
            <div class="seg">
              <button data-preset="schedule" class="${!manual ? 'on' : ''}">Schedule</button>
              <button data-preset="manual" class="${manual ? 'on' : ''}">Manual</button>
            </div>
            <div class="stepper">
              <button class="round" data-step="-1" ${canStep ? '' : 'disabled'}>−</button>
              <span class="setval">${target !== null && target !== undefined ? `${fmt(target)}°` : '–'}</span>
              <button class="round" data-step="1" ${canStep ? '' : 'disabled'}>+</button>
            </div>
          </div>`;
    }

    _onHeadClick(e) {
        const el = e.target.closest('[data-mode],[data-preset],[data-step],[data-act]');
        if (!el) return;
        const entity_id = this._config.entity;
        if (el.dataset.mode) {
            this._hass.callService('climate', 'set_hvac_mode', { entity_id, hvac_mode: el.dataset.mode });
        } else if (el.dataset.preset) {
            this._hass.callService('climate', 'set_preset_mode', { entity_id, preset_mode: el.dataset.preset });
        } else if (el.dataset.act === 'clear') {
            this._hass.callService('slot_thermostat', 'clear_override', { entity_id });
        } else if (el.dataset.step) {
            const a = this._stateObj.attributes;
            const step = a.target_temp_step || this._limits?.step || 0.5;
            const base = this._pending ?? a.temperature ?? (a.current_temperature != null ? Math.round(a.current_temperature / step) * step : 20);
            const next = Math.min(a.max_temp, Math.max(a.min_temp, Math.round((base + step * +el.dataset.step) * 100) / 100));
            this._pending = next;
            this._renderHead();
            clearTimeout(this._stepTimer);
            this._stepTimer = setTimeout(async () => {
                try {
                    await this._hass.callService('climate', 'set_temperature', { entity_id, temperature: this._pending });
                } finally {
                    this._pending = undefined;
                    this._renderHead();
                }
            }, 900);
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
                <ha-icon icon="mdi:calendar-clock"></ha-icon><span>Schedule</span><span class="muted small">· ${summary}</span>
                <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
              </button>`;
            return;
        }
        this._editor.innerHTML = `
          <button class="toggle" data-act="toggle" aria-expanded="true">
            <ha-icon icon="mdi:calendar-clock"></ha-icon><span>Schedule</span>
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
