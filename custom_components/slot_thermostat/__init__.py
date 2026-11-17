"""Slot Thermostat: a scheduled thermostat with named time slots."""

from __future__ import annotations

from dataclasses import dataclass
import logging
from pathlib import Path
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP, Platform
from homeassistant.core import Event, HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .const import (
    CARD_FILENAME,
    CARD_URL,
    CONF_ENTRY_TYPE,
    DOMAIN,
    ENTRY_TYPE_BOILER,
    HEATER_CARD_FILENAME,
    HEATER_CARD_URL,
    SCHEDULE_CARD_FILENAME,
    SCHEDULE_CARD_URL,
    STORAGE_VERSION,
)
from .coordinator import get_manager
from .schedule import ScheduleError, empty_schedule, normalize_schedule
from .websocket import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

THERMOSTAT_PLATFORMS: list[Platform] = [Platform.CLIMATE]
BOILER_PLATFORMS: list[Platform] = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


@dataclass
class SlotThermostatData:
    """Runtime data for one thermostat."""

    store: Store[dict[str, Any]]
    schedule: dict[str, Any]


type SlotThermostatConfigEntry = ConfigEntry[SlotThermostatData]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the websocket API and serve the bundled card."""
    hass.data.setdefault(DOMAIN, {"entities": {}})
    manager = get_manager(hass)

    async def _async_stop(_event: Event) -> None:
        # Fail-safe: never leave a boiler or cooler running while HA is down.
        await manager.async_shutdown()

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _async_stop)
    async_register_websocket_commands(hass)
    await _async_register_card(hass)
    return True


async def _async_register_card(hass: HomeAssistant) -> None:
    if hass.http is None:  # e.g. some test setups
        return
    from homeassistant.components.http import StaticPathConfig  # noqa: PLC0415

    folder = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(CARD_URL, str(folder / CARD_FILENAME), cache_headers=False),
            StaticPathConfig(HEATER_CARD_URL, str(folder / HEATER_CARD_FILENAME), cache_headers=False),
            StaticPathConfig(SCHEDULE_CARD_URL, str(folder / SCHEDULE_CARD_FILENAME), cache_headers=False),
        ]
    )
    if "frontend" not in hass.config.components:
        return
    from homeassistant.components.frontend import add_extra_js_url  # noqa: PLC0415

    integration = await async_get_integration(hass, DOMAIN)
    # The version query makes browsers fetch the new card after an update.
    add_extra_js_url(hass, f"{CARD_URL}?v={integration.version}")
    add_extra_js_url(hass, f"{HEATER_CARD_URL}?v={integration.version}")
    add_extra_js_url(hass, f"{SCHEDULE_CARD_URL}?v={integration.version}")


async def async_setup_entry(hass: HomeAssistant, entry: SlotThermostatConfigEntry) -> bool:
    """Set up a thermostat or a shared heater from a config entry."""
    if _is_boiler(entry):
        await hass.config_entries.async_forward_entry_setups(entry, BOILER_PLATFORMS)
        entry.async_on_unload(entry.add_update_listener(_async_options_updated))
        return True
    store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}")
    raw = await store.async_load()
    try:
        schedule = normalize_schedule(raw) if raw else empty_schedule()
    except ScheduleError as err:
        _LOGGER.warning("Stored schedule for %s is invalid (%s); starting empty", entry.title, err)
        schedule = empty_schedule()
    entry.runtime_data = SlotThermostatData(store=store, schedule=schedule)
    await hass.config_entries.async_forward_entry_setups(entry, THERMOSTAT_PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def _async_options_updated(hass: HomeAssistant, entry: SlotThermostatConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: SlotThermostatConfigEntry) -> bool:
    """Unload a config entry."""
    platforms = BOILER_PLATFORMS if _is_boiler(entry) else THERMOSTAT_PLATFORMS
    return await hass.config_entries.async_unload_platforms(entry, platforms)


async def async_remove_entry(hass: HomeAssistant, entry: SlotThermostatConfigEntry) -> None:
    """Delete the stored schedule when the thermostat is removed."""
    if _is_boiler(entry):
        return
    await Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}").async_remove()


def _is_boiler(entry: ConfigEntry) -> bool:
    return entry.data.get(CONF_ENTRY_TYPE) == ENTRY_TYPE_BOILER
