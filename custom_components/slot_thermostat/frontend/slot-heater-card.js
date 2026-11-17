/*
 * Slot Heater card — bundled with the Slot Thermostat integration.
 * Shows a shared heater (boiler): whether it runs, for how long and which
 * thermostats asked for heat.
 *
 *   type: custom:slot-heater-card
 *   entity: sensor.boiler_status
 *   name: Boiler     # optional
 */
const HEATER_VERSION = '0.2.0';

const hesc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function duration(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return '';
    const m = Math.max(0, Math.floor(seconds / 60));
    const h = Math.floor(m / 60);
    return h ? `${h} h ${m % 60} m` : `${m} m`;
}

const HEATER_CSS = `
:host { display: block; }
ha-card { padding: 20px 16px; text-align: center; cursor: pointer; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; }
ha-icon { --mdc-icon-size: 56px; color: var(--secondary-text-color); transition: color .3s; }
.heating ha-icon, .running ha-icon { color: var(--state-climate-heat-color, #ff8100); animation: flame 1.2s ease-in-out infinite; }
.cooling ha-icon { color: var(--state-climate-cool-color, #2b9af9); animation: flame 2.4s ease-in-out infinite; }
.resting ha-icon { color: var(--warning-color, #ffa600); }
.name { font-size: 13px; color: var(--secondary-text-color); letter-spacing: .04em; text-transform: uppercase; }
.main { font-size: 17px; font-weight: 600; }
.sub { font-size: 13px; color: var(--secondary-text-color); }
@keyframes flame { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.12); } }
@media (prefers-reduced-motion: reduce) { .heating ha-icon, .cooling ha-icon, .running ha-icon { animation: none; } }
`;

class SlotHeaterCard extends HTMLElement {
    static getStubConfig(hass) {
        const ents = hass?.entities || {};
        const entity = Object.keys(ents).find((id) => ents[id].platform === 'slot_thermostat' && id.startsWith('sensor.')) || '';
        return { entity };
    }

    setConfig(config) {
        if (!config || !config.entity) throw new Error('Set `entity` to a Slot Thermostat shared heater status sensor');
        this._config = config;
        if (this._card) this._render();
    }

    getCardSize() {
        return 3;
    }

    getGridOptions() {
        return { columns: 6, min_columns: 3, rows: 'auto' };
    }

    connectedCallback() {
        // Keep "Heating for …" current between state updates.
        this._timer = setInterval(() => this._render(), 30000);
    }

    disconnectedCallback() {
        clearInterval(this._timer);
    }

    set hass(hass) {
        this._hass = hass;
        if (!this._card) {
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>${HEATER_CSS}</style><ha-card></ha-card>`;
            this._card = root.querySelector('ha-card');
            this._card.addEventListener('click', () => {
                const ev = new Event('hass-more-info', { bubbles: true, composed: true });
                ev.detail = { entityId: this._config.entity };
                this.dispatchEvent(ev);
            });
        }
        this._render();
    }

    _render() {
        if (!this._card || !this._hass) return;
        const st = this._hass.states[this._config.entity];
        if (!st) {
            this._card.className = '';
            this._card.innerHTML = `<div class="sub">Entity not found: ${hesc(this._config.entity)}</div>`;
            return;
        }
        const a = st.attributes;
        const lang = this._hass.locale?.language;
        const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) : '');
        const who = (list) => (list && list.length ? list.join(', ') : '');
        let main;
        let sub;
        const running = ['heating', 'cooling', 'running'].includes(st.state);
        if (running) {
            const secs = a.running_since ? (Date.now() - new Date(a.running_since)) / 1000 : null;
            const verb = { heating: 'Heating', cooling: 'Cooling', running: 'Running' }[st.state];
            main = `${verb}${secs != null ? ` for ${duration(secs)}` : ''}`;
            const asking = who(a.requested_by);
            sub = asking ? `Requested by ${asking}` : 'No thermostat is asking for it';
            if (who(a.waiting)) sub += ` · waiting: ${who(a.waiting)}`;
        } else if (st.state === 'resting') {
            main = 'Resting';
            sub = `Maximum run time reached · until ${time(a.resting_until)}`;
        } else if (a.last_run_seconds != null) {
            const verb = a.last_direction === 'cool' ? 'Cooled' : a.last_direction === 'heat' ? 'Heated' : 'Was on';
            main = `${verb} for ${duration(a.last_run_seconds)}`;
            const parts = [];
            if (a.last_on && a.last_off) parts.push(`${time(a.last_on)}–${time(a.last_off)}`);
            if (who(a.last_started_by)) parts.push(`started by ${who(a.last_started_by)}`);
            sub = parts.join(' · ');
        } else {
            main = 'Off';
            sub = '';
        }
        const name = this._config.name || a.friendly_name || '';
        this._card.className = st.state;
        this._card.innerHTML = `
          <ha-icon icon="${{ heating: 'mdi:fire', running: 'mdi:fire', cooling: 'mdi:snowflake', resting: 'mdi:timer-sand' }[st.state] || 'mdi:power-off'}"></ha-icon>
          ${name ? `<div class="name">${hesc(name)}</div>` : ''}
          <div class="main">${hesc(main)}</div>
          ${sub ? `<div class="sub">${hesc(sub)}</div>` : ''}`;
    }
}

if (!customElements.get('slot-heater-card')) {
    customElements.define('slot-heater-card', SlotHeaterCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
        type: 'slot-heater-card',
        name: 'Slot Heater',
        description: 'Shared device (boiler, heat pump, AC): running time and which thermostats asked for it.',
        documentationURL: 'https://github.com/iamBiB/ha-slot-thermostat',
    });
    console.info(`%c SLOT-HEATER-CARD %c ${HEATER_VERSION} `, 'background:#ff7043;color:#fff;border-radius:3px 0 0 3px', 'background:#444;color:#fff;border-radius:0 3px 3px 0');
}
