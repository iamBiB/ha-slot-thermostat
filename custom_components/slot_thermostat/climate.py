"""Climate entity for Slot Thermostat."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import logging
from typing import TYPE_CHECKING, Any, Literal

import voluptuous as vol

from homeassistant.components.climate import (
    ATTR_HVAC_MODE,
    ATTR_HVAC_MODES,
    ClimateEntity,
    ClimateEntityFeature,
    HVACAction,
    HVACMode,
)
from homeassistant.const import (
    ATTR_ENTITY_ID,
    ATTR_TEMPERATURE,
    ATTR_UNIT_OF_MEASUREMENT,
    STATE_ON,
    STATE_UNAVAILABLE,
    STATE_UNKNOWN,
    UnitOfTemperature,
)
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import entity_platform
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.helpers.start import async_at_started
from homeassistant.util import dt as dt_util
from homeassistant.util.unit_conversion import TemperatureConverter

from .const import (
    ATTR_SCHEDULE,
    CONF_CLIMATES,
    CONF_COOL_OFFSET,
    CONF_COOLERS,
    CONF_HEATERS,
    CONF_MAX_TEMP,
    CONF_MIN_CYCLE,
    CONF_MIN_TEMP,
    CONF_SENSORS,
    CONF_START_MARGIN,
    CONF_STOP_MARGIN,
    CONF_TEMP_STEP,
    CONF_WINDOWS,
    DEFAULT_COOL_OFFSET,
    DEFAULT_MANUAL_TEMP,
    DEFAULT_MAX_TEMP,
    DEFAULT_MIN_CYCLE,
    DEFAULT_MIN_TEMP,
    DEFAULT_START_MARGIN,
    DEFAULT_STOP_MARGIN,
    DEFAULT_TEMP_STEP,
    DOMAIN,
    PRESET_MANUAL,
    PRESET_SCHEDULE,
    SERVICE_CLEAR_OVERRIDE,
    SERVICE_SET_SCHEDULE,
)
from .coordinator import get_manager
from .schedule import (
    ActiveSlot,
    ScheduleError,
    active_slot,
    next_change,
    next_slot,
    normalize_schedule,
)

if TYPE_CHECKING:
    from . import SlotThermostatConfigEntry

_LOGGER = logging.getLogger(__name__)

TICK_INTERVAL = timedelta(seconds=30)
TEMPERATURE_UNITS = {
    UnitOfTemperature.CELSIUS,
    UnitOfTemperature.FAHRENHEIT,
    UnitOfTemperature.KELVIN,
}

ATTR_ACTIVE_SLOT = "active_slot"
ATTR_SLOT_START = "slot_start"
ATTR_SLOT_TEMP = "slot_temperature"
ATTR_SLOT_END = "slot_end"
ATTR_NEXT_SLOT = "next_slot"
ATTR_NEXT_SLOT_START = "next_slot_start"
ATTR_NEXT_CHANGE = "next_change"
ATTR_OVERRIDE_TEMP = "override_temperature"
ATTR_OVERRIDE_UNTIL = "override_until"
ATTR_MANUAL_TEMP = "manual_temperature"
ATTR_COOL_ABOVE = "cool_above"
ATTR_SCHEDULE_MODE = "schedule_mode"
ATTR_WINDOW_OPEN = "window_open"
ATTR_SENSORS_AVAILABLE = "sensors_available"
ATTR_TEMPERATURE_SENSORS = "temperature_sensors"
ATTR_REASON = "reason"
ATTR_STATUS = "status"

Direction = Literal["heat", "cool"]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SlotThermostatConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the thermostat entity."""
    async_add_entities([SlotThermostat(hass, entry)])

    platform = entity_platform.async_get_current_platform()
    platform.async_register_entity_service(
        SERVICE_SET_SCHEDULE,
        {vol.Required(ATTR_SCHEDULE): dict},
        "async_set_schedule",
    )
    platform.async_register_entity_service(
        SERVICE_CLEAR_OVERRIDE, None, "async_clear_override"
    )


class SlotThermostat(ClimateEntity, RestoreEntity):
    """A thermostat driven by named time slots.

    hvac_mode picks the direction (heat, cool, heat_cool or off); the preset
    picks where the target comes from (the schedule or a manual temperature).
    """

    _attr_has_entity_name = True
    _attr_name = None
    _attr_should_poll = False
    _attr_translation_key = "slot_thermostat"
    _attr_preset_modes = [PRESET_SCHEDULE, PRESET_MANUAL]
    _attr_supported_features = (
        ClimateEntityFeature.TARGET_TEMPERATURE
        | ClimateEntityFeature.PRESET_MODE
        | ClimateEntityFeature.TURN_ON
        | ClimateEntityFeature.TURN_OFF
    )

    def __init__(self, hass: HomeAssistant, entry: SlotThermostatConfigEntry) -> None:
        """Initialize from the config entry."""
        self._entry = entry
        options = {**entry.data, **entry.options}
        self._sensors: list[str] = list(options[CONF_SENSORS])
        self._heaters: list[str] = list(options.get(CONF_HEATERS) or [])
        self._coolers: list[str] = list(options.get(CONF_COOLERS) or [])
        self._climates: list[str] = list(options.get(CONF_CLIMATES) or [])
        self._windows: list[str] = list(options.get(CONF_WINDOWS) or [])
        self._start_margin = float(options.get(CONF_START_MARGIN, DEFAULT_START_MARGIN))
        self._stop_margin = float(options.get(CONF_STOP_MARGIN, DEFAULT_STOP_MARGIN))
        self._cool_offset = float(options.get(CONF_COOL_OFFSET, DEFAULT_COOL_OFFSET))
        self._min_cycle = timedelta(minutes=float(options.get(CONF_MIN_CYCLE, DEFAULT_MIN_CYCLE)))

        self._attr_unique_id = entry.entry_id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Slot Thermostat",
            model="Scheduled thermostat",
            entry_type=DeviceEntryType.SERVICE,
        )
        self._attr_temperature_unit = hass.config.units.temperature_unit
        self._attr_min_temp = float(options.get(CONF_MIN_TEMP, DEFAULT_MIN_TEMP))
        self._attr_max_temp = float(options.get(CONF_MAX_TEMP, DEFAULT_MAX_TEMP))
        self._attr_target_temperature_step = float(options.get(CONF_TEMP_STEP, DEFAULT_TEMP_STEP))

        self._schedule: dict[str, Any] = entry.runtime_data.schedule
        self._hvac_mode: HVACMode | None = None  # set on restore / first start
        self._preset = PRESET_SCHEDULE
        self._manual_temp: float | None = None
        self._override_temp: float | None = None
        self._override_until: datetime | None = None

        self._current: float | None = None
        self._sensors_available = 0
        self._window_open = False
        self._active: ActiveSlot | None = None
        self._last_switch: datetime | None = None
        self._reason = "starting"
        self._lock = asyncio.Lock()
        self._started = False
        # Set when the user changes target/mode/preset/schedule: the next decision
        # ignores the margins and may stop at once, so the change takes effect now.
        self._user_change = False
        # What this thermostat itself asks for. Switches may be shared with other
        # thermostats, so their on/off state alone doesn't tell us that.
        self._demand: Direction | None = None

    # ----------------------------------------------------------- capability

    def _climate_supports(self, entity_id: str, mode: HVACMode) -> bool:
        state = self.hass.states.get(entity_id)
        modes = state.attributes.get(ATTR_HVAC_MODES) if state else None
        # Unknown (e.g. unavailable at startup): assume a typical AC that does both.
        return True if not modes else mode in modes

    def _heat_climates(self) -> list[str]:
        return [c for c in self._climates if self._climate_supports(c, HVACMode.HEAT)]

    def _cool_climates(self) -> list[str]:
        return [c for c in self._climates if self._climate_supports(c, HVACMode.COOL)]

    @property
    def _can_heat(self) -> bool:
        return bool(self._heaters or self._heat_climates())

    @property
    def _can_cool(self) -> bool:
        return bool(self._coolers or self._cool_climates())

    @property
    def hvac_modes(self) -> list[HVACMode]:
        """Modes depend on what the controlled devices can do."""
        modes = []
        if self._can_heat:
            modes.append(HVACMode.HEAT)
        if self._can_cool:
            modes.append(HVACMode.COOL)
        if self._can_heat and self._can_cool:
            modes.append(HVACMode.HEAT_COOL)
        return [*modes, HVACMode.OFF]

    # ------------------------------------------------------------------ state

    @property
    def entry_id(self) -> str:
        """The config entry this thermostat belongs to."""
        return self._entry.entry_id

    @property
    def schedule(self) -> dict[str, Any]:
        """The current schedule."""
        return self._schedule

    @property
    def hvac_mode(self) -> HVACMode | None:
        """heat, cool, heat_cool or off."""
        return self._hvac_mode

    @property
    def preset_mode(self) -> str:
        """schedule or manual."""
        return self._preset

    @property
    def current_temperature(self) -> float | None:
        """Average of the available sensors."""
        return self._current

    @property
    def target_temperature(self) -> float | None:
        """Temperature aimed for now. In heat_cool it is the heating target."""
        return self._target()

    @property
    def hvac_action(self) -> HVACAction:
        """What the thermostat is doing."""
        if self._hvac_mode == HVACMode.OFF:
            return HVACAction.OFF
        if self._demand is not None:
            manager = get_manager(self.hass)
            devices = self._devices_for(self._demand)
            if any(manager.serves(d, self.entity_id) for d in devices):
                return HVACAction.HEATING if self._demand == "heat" else HVACAction.COOLING
        return HVACAction.IDLE

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Schedule details for the card and automations."""
        now = dt_util.now()
        upcoming = next_slot(self._schedule, now)
        change = next_change(self._schedule, now)
        target = self._target()
        cool_above = (
            round(target + self._cool_offset, 2)
            if target is not None and self._hvac_mode == HVACMode.HEAT_COOL
            else None
        )
        return {
            ATTR_ACTIVE_SLOT: (self._active.slot["title"] or None) if self._active else None,
            ATTR_SLOT_TEMP: float(self._active.slot["temp"]) if self._active else None,
            ATTR_SLOT_START: self._active.start.isoformat() if self._active else None,
            ATTR_SLOT_END: self._active.end.isoformat() if self._active else None,
            ATTR_NEXT_SLOT: (upcoming.slot["title"] or None) if upcoming else None,
            ATTR_NEXT_SLOT_START: upcoming.start.isoformat() if upcoming else None,
            ATTR_NEXT_CHANGE: change.isoformat() if change else None,
            ATTR_OVERRIDE_TEMP: self._override_temp,
            ATTR_OVERRIDE_UNTIL: self._override_until.isoformat() if self._override_until else None,
            ATTR_MANUAL_TEMP: self._manual_temp,
            ATTR_COOL_ABOVE: cool_above,
            ATTR_SCHEDULE_MODE: self._schedule["mode"],
            ATTR_WINDOW_OPEN: self._window_open,
            ATTR_SENSORS_AVAILABLE: f"{self._sensors_available}/{len(self._sensors)}",
            # lets the card find e.g. the humidity sensor on the same device
            ATTR_TEMPERATURE_SENSORS: list(self._sensors),
            ATTR_REASON: self._reason,
            ATTR_STATUS: self._status_text(upcoming),
        }

    def _status_text(self, upcoming: ActiveSlot | None) -> str:
        """One readable line for other cards, e.g. "Leaving home · until 10:00"."""
        def hm(when: datetime) -> str:
            local = dt_util.as_local(when)
            return "midnight" if (local.hour, local.minute) == (0, 0) else local.strftime("%H:%M")

        def temp(slot: dict[str, Any]) -> str:
            return f"{float(slot['temp']):g}°"

        if self._hvac_mode == HVACMode.OFF:
            return "Off"
        if self._window_open:
            return "Window open · paused"
        if self._preset == PRESET_MANUAL:
            return f"Manual · {self._manual_temp:g}°" if self._manual_temp is not None else "Manual"
        if self._override_temp is not None:
            until = f" · until {hm(self._override_until)}" if self._override_until else ""
            return f"Override {self._override_temp:g}°{until}"
        if self._active:
            title = self._active.slot["title"] or "Slot"
            return f"{title} · {temp(self._active.slot)} · until {hm(self._active.end)}"
        if upcoming:
            title = upcoming.slot["title"] or "Next slot"
            return f"No slot · {title} {temp(upcoming.slot)} at {hm(upcoming.start)}"
        return "No slots scheduled"

    def _target(self) -> float | None:
        if self._hvac_mode in (None, HVACMode.OFF):
            return None
        if self._preset == PRESET_MANUAL:
            return self._manual_temp
        if self._override_temp is not None:
            return self._override_temp
        return float(self._active.slot["temp"]) if self._active else None

    def _is_on(self, entity_id: str) -> bool:
        return self.hass.states.is_state(entity_id, STATE_ON)

    def _climate_mode(self, entity_id: str) -> str | None:
        state = self.hass.states.get(entity_id)
        return state.state if state else None

    def _running(self) -> Direction | None:
        """Which direction this thermostat is asking for.

        Devices can be shared with other thermostats, so their state doesn't tell
        us whether *we* asked; the manager corrects devices changed elsewhere.
        """
        return self._demand

    def _devices_for(self, direction: Direction) -> list[str]:
        manager = get_manager(self.hass)
        switches = self._heaters if direction == "heat" else self._coolers
        return [*switches, *(c for c in self._climates if manager.supports(c, direction))]

    # -------------------------------------------------------------- lifecycle

    async def async_added_to_hass(self) -> None:
        """Restore state, subscribe to inputs and start the control loop."""
        await super().async_added_to_hass()
        self.hass.data[DOMAIN]["entities"][self.entity_id] = self
        await self._async_restore()

        self.async_on_remove(
            async_track_state_change_event(
                self.hass, self._sensors + self._windows, self._async_input_changed
            )
        )
        self.async_on_remove(
            async_track_state_change_event(
                self.hass,
                self._heaters + self._coolers + self._climates,
                self._async_device_changed,
            )
        )
        self.async_on_remove(
            async_track_time_interval(self.hass, self._async_tick, TICK_INTERVAL)
        )
        self._read_inputs()
        self._active = active_slot(self._schedule, dt_util.now())
        self.async_on_remove(async_at_started(self.hass, self._async_started))

    async def async_will_remove_from_hass(self) -> None:
        """Unregister and release any shared switches."""
        self.hass.data[DOMAIN]["entities"].pop(self.entity_id, None)
        await get_manager(self.hass).async_release(self.entity_id)
        await super().async_will_remove_from_hass()

    async def _async_restore(self) -> None:
        last = await self.async_get_last_state()
        if last is not None:
            try:
                self._hvac_mode = HVACMode(last.state)
            except ValueError:
                self._hvac_mode = None
            attrs = last.attributes
            if attrs.get("preset_mode") in self._attr_preset_modes:
                self._preset = attrs["preset_mode"]
            if (manual := attrs.get(ATTR_MANUAL_TEMP)) is not None:
                self._manual_temp = float(manual)
            until = dt_util.parse_datetime(attrs.get(ATTR_OVERRIDE_UNTIL) or "")
            override = attrs.get(ATTR_OVERRIDE_TEMP)
            if override is not None and (until is None or until > dt_util.now()):
                self._override_temp = float(override)
                self._override_until = until
        if self._hvac_mode is None or self._hvac_mode not in self.hvac_modes:
            self._hvac_mode = self.hvac_modes[0]

    async def _async_started(self, _hass: HomeAssistant) -> None:
        self._started = True
        await self._async_control()

    # ---------------------------------------------------------------- inputs

    def _read_inputs(self) -> None:
        values: list[float] = []
        for entity_id in self._sensors:
            state = self.hass.states.get(entity_id)
            if state is None or state.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
                continue
            try:
                value = float(state.state)
            except ValueError:
                continue
            unit = state.attributes.get(ATTR_UNIT_OF_MEASUREMENT)
            if unit in TEMPERATURE_UNITS and unit != self.temperature_unit:
                value = TemperatureConverter.convert(value, unit, self.temperature_unit)
            values.append(value)
        self._sensors_available = len(values)
        self._current = round(sum(values) / len(values), 2) if values else None
        self._window_open = any(self._is_on(entity_id) for entity_id in self._windows)

    async def _async_input_changed(self, event: Event[EventStateChangedData]) -> None:
        self._read_inputs()
        await self._async_control()

    @callback
    def _async_device_changed(self, event: Event[EventStateChangedData]) -> None:
        self.async_write_ha_state()

    async def _async_tick(self, _now: datetime) -> None:
        await self._async_control()

    # --------------------------------------------------------------- control

    def _decide(
        self, running: Direction | None, fresh: bool = False
    ) -> tuple[Direction | None, bool]:
        """Return (wanted direction, is_safety_stop) and set the reason.

        ``fresh`` (after a user change) compares against the target only, without
        the start and stop margins.
        """
        target = self._target()
        cur = self._current
        if self._hvac_mode == HVACMode.OFF:
            self._reason = "off"
            return None, True
        if target is None:
            self._reason = "no slot" if self._preset == PRESET_SCHEDULE else "no temperature set"
            return None, True
        if self._window_open:
            self._reason = "window open"
            return None, True
        if cur is None:
            self._reason = "no temperature reading"
            return None, True

        heat_target = target if self._hvac_mode in (HVACMode.HEAT, HVACMode.HEAT_COOL) else None
        cool_target = (
            target
            if self._hvac_mode == HVACMode.COOL
            else target + self._cool_offset
            if self._hvac_mode == HVACMode.HEAT_COOL
            else None
        )
        start, stop = (0.0, 0.0) if fresh else (self._start_margin, self._stop_margin)

        if heat_target is not None and self._can_heat:
            if running == "heat":
                if cur < heat_target + stop:
                    self._reason = "heating"
                    return "heat", False
            elif cur < heat_target if fresh else cur <= heat_target - start:
                self._reason = "below target"
                return "heat", False
        if cool_target is not None and self._can_cool:
            if running == "cool":
                if cur > cool_target - stop:
                    self._reason = "cooling"
                    return "cool", False
            elif cur > cool_target if fresh else cur >= cool_target + start:
                self._reason = "above target"
                return "cool", False
        self._reason = "target reached" if running else "within margin"
        return None, False

    async def _async_control(self) -> None:
        """Decide what to do, then drive the devices."""
        if not self._started:
            self.async_write_ha_state()
            return
        async with self._lock:
            now = dt_util.now()
            self._active = active_slot(self._schedule, now)
            if self._override_until is not None and now >= self._override_until:
                self._clear_override()

            fresh, self._user_change = self._user_change, False
            running = self._running()
            want, safety = self._decide(running, fresh)
            cycle_ok = (
                self._last_switch is None
                or dt_util.utcnow() - self._last_switch >= self._min_cycle
            )
            # A stop the user asked for is never delayed; starts still respect the
            # minimum off time (compressor protection).
            user_stop = fresh and want is None
            if want != running and not safety and not cycle_ok and not user_stop:
                self._reason += " (waiting for minimum cycle)"
            else:
                await self._async_apply(want, switching=want != running)
        self.async_write_ha_state()

    async def _async_apply(self, want: Direction | None, switching: bool) -> None:
        """Make the devices match ``want``; only send commands that change something."""
        target = self._target()
        if want == "cool" and self._hvac_mode == HVACMode.HEAT_COOL and target is not None:
            target += self._cool_offset

        manager = get_manager(self.hass)
        try:
            await manager.async_update(
                self.entity_id, self._entry.title, self._heaters, self._coolers, self._climates, want, target
            )
        except HomeAssistantError as err:
            _LOGGER.error("%s: could not drive devices: %s", self.entity_id, err)
            return
        if switching:
            self._last_switch = dt_util.utcnow()
        self._demand = want
        if want is not None:
            devices = self._devices_for(want)
            if devices and not any(manager.serves(d, self.entity_id) for d in devices):
                reasons = [r for d in devices if (r := manager.waiting_reason(d, self.entity_id))]
                if reasons:
                    self._reason += f" (waiting: {'; '.join(reasons)})"

    def _clear_override(self) -> None:
        self._override_temp = None
        self._override_until = None

    # -------------------------------------------------------------- services

    async def async_set_temperature(self, **kwargs: Any) -> None:
        """Set a temperature.

        With the schedule preset this is an override that holds until the next
        slot starts or ends. With the manual preset it sets the manual target.
        """
        self._user_change = True
        if (mode := kwargs.get(ATTR_HVAC_MODE)) is not None:
            self._apply_mode(HVACMode(mode))
        temperature = kwargs.get(ATTR_TEMPERATURE)
        if temperature is not None:
            temperature = float(temperature)
            if self._preset == PRESET_SCHEDULE:
                self._override_temp = temperature
                self._override_until = next_change(self._schedule, dt_util.now())
            else:
                self._manual_temp = temperature
        await self._async_control()

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        """Change direction: heat, cool, heat_cool or off."""
        self._user_change = True
        self._apply_mode(hvac_mode)
        await self._async_control()

    def _apply_mode(self, hvac_mode: HVACMode) -> None:
        if hvac_mode not in self.hvac_modes:
            raise ServiceValidationError(
                f"{self.entity_id} can't {hvac_mode}: none of its devices support it"
            )
        if hvac_mode != self._hvac_mode:
            self._clear_override()
        self._hvac_mode = hvac_mode

    async def async_set_preset_mode(self, preset_mode: str) -> None:
        """Switch between following the schedule and a manual temperature."""
        self._user_change = True
        if preset_mode not in self._attr_preset_modes:
            raise ServiceValidationError(f"Unknown preset {preset_mode}")
        if preset_mode == PRESET_MANUAL and self._manual_temp is None:
            self._manual_temp = self._target() or self._current_rounded() or DEFAULT_MANUAL_TEMP
        self._preset = preset_mode
        self._clear_override()
        await self._async_control()

    def _current_rounded(self) -> float | None:
        if self._current is None:
            return None
        step = self.target_temperature_step or 0.5
        return round(round(self._current / step) * step, 2)

    async def async_turn_on(self) -> None:
        """Turn on in the first available direction (heat, else cool)."""
        await self.async_set_hvac_mode(self.hvac_modes[0])

    async def async_turn_off(self) -> None:
        """Turn off."""
        await self.async_set_hvac_mode(HVACMode.OFF)

    async def async_set_schedule(self, schedule: dict[str, Any]) -> None:
        """Validate, store and apply a new schedule. Clears any override."""
        try:
            normalized = normalize_schedule(schedule, self.min_temp, self.max_temp)
        except ScheduleError as err:
            raise ServiceValidationError(str(err)) from err
        self._user_change = True
        self._schedule = normalized
        self._entry.runtime_data.schedule = normalized
        await self._entry.runtime_data.store.async_save(normalized)
        self._clear_override()
        await self._async_control()

    async def async_clear_override(self) -> None:
        """Go back to the schedule."""
        self._user_change = True
        self._clear_override()
        await self._async_control()
