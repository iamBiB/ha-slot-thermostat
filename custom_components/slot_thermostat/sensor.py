"""Status sensor for a Shared device entry (boiler, heat pump, AC …)."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.restore_state import RestoreEntity

from .const import (
    CONF_ENFORCE_OFF,
    CONF_KEEP_ALIVE,
    CONF_MAX_RUN,
    CONF_NOTIFY,
    CONF_REST,
    CONF_SWITCH,
    DEFAULT_KEEP_ALIVE,
    DEFAULT_MAX_RUN,
    DEFAULT_REST,
    DOMAIN,
)
from .coordinator import DeviceSettings, get_manager

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry

TICK_INTERVAL = timedelta(seconds=30)
STATES = ["heating", "cooling", "running", "resting", "off"]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the shared device status sensor."""
    async_add_entities([BoilerStatusSensor(entry)])


def _minutes(value: Any) -> timedelta | None:
    minutes = float(value or 0)
    return timedelta(minutes=minutes) if minutes > 0 else None


class BoilerStatusSensor(SensorEntity, RestoreEntity):
    """heating / cooling / resting / off, with who asked and for how long."""

    _attr_has_entity_name = True
    _attr_translation_key = "boiler_status"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = STATES
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize from the entry options."""
        options = {**entry.data, **entry.options}
        self._switch: str = options[CONF_SWITCH]
        self._settings = DeviceSettings(
            name=entry.title,
            keep_alive=_minutes(options.get(CONF_KEEP_ALIVE, DEFAULT_KEEP_ALIVE)),
            max_run=_minutes(options.get(CONF_MAX_RUN, DEFAULT_MAX_RUN)),
            rest=_minutes(options.get(CONF_REST, DEFAULT_REST)) or timedelta(0),
            notify=bool(options.get(CONF_NOTIFY, True)),
            enforce_off=bool(options.get(CONF_ENFORCE_OFF, True)),
        )
        self._attr_unique_id = f"{entry.entry_id}_status"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Slot Thermostat",
            model="Shared device",
            entry_type=DeviceEntryType.SERVICE,
        )

    @property
    def native_value(self) -> str:
        """heating, cooling, running (other modes), resting or off."""
        manager = get_manager(self.hass)
        if manager.is_running(self._switch):
            direction = manager.running_direction(self._switch)
            return {"heat": "heating", "cool": "cooling"}.get(direction or "", "running")
        return "resting" if manager.is_resting(self._switch) else "off"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Who asked, since when, and the last run."""
        return {"switch": self._switch, **get_manager(self.hass).summary(self._switch)}

    async def async_added_to_hass(self) -> None:
        """Register with the manager and follow the switch."""
        await super().async_added_to_hass()
        manager = get_manager(self.hass)
        if (last := await self.async_get_last_state()) is not None:
            manager.restore(self._switch, dict(last.attributes))
        manager.state(self._switch).settings = self._settings
        manager.async_device_changed(self._switch)

        self.async_on_remove(manager.async_listen(self._switch, self.async_write_ha_state))
        self.async_on_remove(
            async_track_state_change_event(self.hass, [self._switch], self._async_switch_changed)
        )
        self.async_on_remove(async_track_time_interval(self.hass, self._async_tick, TICK_INTERVAL))

    async def async_will_remove_from_hass(self) -> None:
        """Stop applying protection rules to the device."""
        get_manager(self.hass).state(self._switch).settings = None
        await super().async_will_remove_from_hass()

    @callback
    def _async_switch_changed(self, event: Event[EventStateChangedData]) -> None:
        get_manager(self.hass).async_device_changed(self._switch)
        self.async_write_ha_state()

    async def _async_tick(self, _now: datetime) -> None:
        await get_manager(self.hass).async_tick(self._switch)
        self.async_write_ha_state()
