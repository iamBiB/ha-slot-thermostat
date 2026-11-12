"""Websocket API used by the Slot Thermostat card."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError

from .const import DOMAIN, WS_GET_SCHEDULE, WS_SET_SCHEDULE

if TYPE_CHECKING:
    from .climate import SlotThermostat


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register the websocket commands."""
    websocket_api.async_register_command(hass, ws_get_schedule)
    websocket_api.async_register_command(hass, ws_set_schedule)


def _get_entity(hass: HomeAssistant, entity_id: str) -> SlotThermostat | None:
    return hass.data.get(DOMAIN, {}).get("entities", {}).get(entity_id)


def _payload(entity: SlotThermostat) -> dict[str, Any]:
    return {
        "schedule": entity.schedule,
        "min_temp": entity.min_temp,
        "max_temp": entity.max_temp,
        "step": entity.target_temperature_step,
    }


@websocket_api.websocket_command(
    {vol.Required("type"): WS_GET_SCHEDULE, vol.Required("entity_id"): str}
)
@callback
def ws_get_schedule(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return the schedule of a thermostat."""
    entity = _get_entity(hass, msg["entity_id"])
    if entity is None:
        connection.send_error(msg["id"], "not_found", f"{msg['entity_id']} is not a Slot Thermostat")
        return
    connection.send_result(msg["id"], _payload(entity))


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_SET_SCHEDULE,
        vol.Required("entity_id"): str,
        vol.Required("schedule"): dict,
    }
)
@websocket_api.async_response
async def ws_set_schedule(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Validate, store and apply a new schedule."""
    entity = _get_entity(hass, msg["entity_id"])
    if entity is None:
        connection.send_error(msg["id"], "not_found", f"{msg['entity_id']} is not a Slot Thermostat")
        return
    try:
        await entity.async_set_schedule(msg["schedule"])
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "invalid_schedule", str(err))
        return
    connection.send_result(msg["id"], _payload(entity))
