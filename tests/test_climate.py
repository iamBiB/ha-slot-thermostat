"""Tests for the thermostat entity, config flow and websocket API."""

from datetime import timedelta
from typing import Any

import pytest

from homeassistant import config_entries
from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACAction,
    HVACMode,
)
from homeassistant.const import ATTR_TEMPERATURE, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    MockModule,
    MockPlatform,
    async_fire_time_changed,
    mock_integration,
    mock_platform,
)

from custom_components.slot_thermostat.const import DOMAIN

ENTITY = "climate.living"
HEATER = "input_boolean.heater"
COOLER = "input_boolean.cooler"
AC = "climate.fake_ac"
SENSOR_A = "sensor.temp_a"
SENSOR_B = "sensor.temp_b"
WINDOW = "binary_sensor.window"

BASE = {
    "temperature_sensors": [SENSOR_A, SENSOR_B],
    "window_sensors": [WINDOW],
    "start_margin": 0.3,
    "stop_margin": 0.3,
    "heat_cool_gap": 2,
    "min_cycle_minutes": 0,
    "min_temp": 5,
    "max_temp": 30,
    "target_temp_step": "0.5",
}
HEAT_ONLY = {**BASE, "heaters": [HEATER]}


class FakeAC(ClimateEntity):
    """Minimal AC that heats and cools."""

    _attr_name = "Fake AC"
    _attr_unique_id = "fake_ac"
    _attr_hvac_modes = [HVACMode.OFF, HVACMode.HEAT, HVACMode.COOL]
    _attr_hvac_mode = HVACMode.OFF
    _attr_target_temperature = 24
    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_supported_features = (
        ClimateEntityFeature.TARGET_TEMPERATURE | ClimateEntityFeature.TURN_ON | ClimateEntityFeature.TURN_OFF
    )

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        self._attr_hvac_mode = hvac_mode
        self.async_write_ha_state()

    async def async_set_temperature(self, **kwargs: Any) -> None:
        if "hvac_mode" in kwargs:
            self._attr_hvac_mode = kwargs["hvac_mode"]
        self._attr_target_temperature = kwargs[ATTR_TEMPERATURE]
        self.async_write_ha_state()


def slots_now(temp: float = 21.0) -> dict:
    """A daily schedule whose slot covers the current time (hour boundaries)."""
    now = dt_util.now()
    start = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
    end = start + timedelta(hours=3)
    return {
        "mode": "daily",
        "daily": [{"title": "Now", "start": start.strftime("%H:%M"), "end": end.strftime("%H:%M"), "temp": temp}],
    }


def set_temps(hass: HomeAssistant, a: float, b: float | None = None) -> None:
    hass.states.async_set(SENSOR_A, str(a), {"unit_of_measurement": "°C"})
    hass.states.async_set(SENSOR_B, str(a if b is None else b), {"unit_of_measurement": "°C"})


async def base_setup(hass: HomeAssistant, freezer, with_ac: bool = False) -> None:
    freezer.move_to("2026-11-11 12:20:00+02:00")
    await hass.config.async_set_time_zone("Europe/Bucharest")
    assert await async_setup_component(hass, "homeassistant", {})
    assert await async_setup_component(
        hass, "input_boolean", {"input_boolean": {"heater": {}, "cooler": {}, "heater_2": {}}}
    )
    if with_ac:
        async def setup_platform(hass, config, add_entities, discovery_info=None):
            add_entities([FakeAC()])

        mock_integration(hass, MockModule("fake"))
        mock_platform(hass, "fake.climate", MockPlatform(async_setup_platform=setup_platform))
        assert await async_setup_component(hass, "climate", {"climate": {"platform": "fake"}})
    set_temps(hass, 19.0, 19.4)
    hass.states.async_set(WINDOW, "off")
    await hass.async_block_till_done()


async def add_thermostat(hass, options, title="Living"):
    entry = MockConfigEntry(domain=DOMAIN, title=title, options=options)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


@pytest.fixture
async def thermostat(hass: HomeAssistant, freezer):
    await base_setup(hass, freezer)
    return await add_thermostat(hass, HEAT_ONLY)


async def set_schedule(hass, schedule, entity=ENTITY):
    await hass.services.async_call(DOMAIN, "set_schedule", {"entity_id": entity, "schedule": schedule}, blocking=True)
    await hass.async_block_till_done()


async def call(hass, service, **data):
    await hass.services.async_call("climate", service, {"entity_id": ENTITY, **data}, blocking=True)
    await hass.async_block_till_done()


async def test_defaults_and_gap_means_off(hass, thermostat):
    state = hass.states.get(ENTITY)
    assert state.state == HVACMode.HEAT
    assert state.attributes["hvac_modes"] == [HVACMode.HEAT, HVACMode.OFF]
    assert state.attributes["preset_mode"] == "schedule"
    assert state.attributes["current_temperature"] == 19.2
    assert state.attributes["temperature"] is None
    assert state.attributes["reason"] == "no slot"
    assert hass.states.get(HEATER).state == "off"


async def test_heats_with_margins(hass, thermostat):
    await set_schedule(hass, slots_now(21))
    state = hass.states.get(ENTITY)
    assert state.attributes["active_slot"] == "Now"
    assert state.attributes["temperature"] == 21
    assert hass.states.get(HEATER).state == "on"
    assert state.attributes["hvac_action"] == HVACAction.HEATING

    for temp, expected in [(21.1, "on"), (21.3, "off"), (20.8, "off"), (20.7, "on")]:
        set_temps(hass, temp)
        await hass.async_block_till_done()
        assert hass.states.get(HEATER).state == expected, temp


async def test_window_and_missing_sensors_stop(hass, thermostat):
    await set_schedule(hass, slots_now(21))
    assert hass.states.get(HEATER).state == "on"
    hass.states.async_set(WINDOW, "on")
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off"
    assert hass.states.get(ENTITY).attributes["window_open"] is True

    hass.states.async_set(WINDOW, "off")
    hass.states.async_set(SENSOR_A, "unavailable")
    hass.states.async_set(SENSOR_B, "unavailable")
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off"
    assert hass.states.get(ENTITY).attributes["reason"] == "no temperature reading"


async def test_override_holds_until_next_change(hass, thermostat, freezer):
    await set_schedule(hass, slots_now(18))  # slot 11:00–14:00, now 12:20
    assert hass.states.get(HEATER).state == "off"
    await call(hass, "set_temperature", temperature=23)
    state = hass.states.get(ENTITY)
    assert state.attributes["temperature"] == 23
    assert state.attributes["override_until"].startswith("2026-11-11T14:00")
    assert hass.states.get(HEATER).state == "on"

    freezer.move_to("2026-11-11 14:00:30+02:00")
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    state = hass.states.get(ENTITY)
    assert state.attributes["override_temperature"] is None
    assert state.attributes["temperature"] is None
    assert hass.states.get(HEATER).state == "off"


async def test_manual_preset_and_off(hass, thermostat):
    await call(hass, "set_preset_mode", preset_mode="manual")
    await call(hass, "set_temperature", temperature=22)
    assert hass.states.get(ENTITY).attributes["temperature"] == 22
    assert hass.states.get(HEATER).state == "on"

    await call(hass, "turn_off")
    assert hass.states.get(ENTITY).state == HVACMode.OFF
    assert hass.states.get(HEATER).state == "off"

    await call(hass, "turn_on")
    assert hass.states.get(ENTITY).state == HVACMode.HEAT
    assert hass.states.get(HEATER).state == "on"


async def test_unsupported_mode_rejected(hass, thermostat):
    with pytest.raises(Exception, match="not valid"):
        await call(hass, "set_hvac_mode", hvac_mode="cool")


async def test_min_cycle(hass, freezer):
    await base_setup(hass, freezer)
    set_temps(hass, 19)
    await add_thermostat(hass, {**HEAT_ONLY, "min_cycle_minutes": 5})
    await set_schedule(hass, slots_now(21))
    assert hass.states.get(HEATER).state == "on"

    set_temps(hass, 22)
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "on"
    assert "minimum cycle" in hass.states.get(ENTITY).attributes["reason"]

    freezer.tick(timedelta(minutes=5, seconds=31))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off"


async def test_cooling_switch(hass, freezer):
    await base_setup(hass, freezer)
    await add_thermostat(hass, {**BASE, "coolers": [COOLER]})
    state = hass.states.get(ENTITY)
    assert state.state == HVACMode.COOL
    assert state.attributes["hvac_modes"] == [HVACMode.COOL, HVACMode.OFF]
    await set_schedule(hass, slots_now(24))

    for temp, expected in [(24.2, "off"), (24.3, "on"), (23.8, "on"), (23.7, "off")]:
        set_temps(hass, temp)
        await hass.async_block_till_done()
        assert hass.states.get(COOLER).state == expected, temp
    set_temps(hass, 25)
    await hass.async_block_till_done()
    assert hass.states.get(ENTITY).attributes["hvac_action"] == HVACAction.COOLING


async def test_heat_cool_with_gap(hass, freezer):
    await base_setup(hass, freezer)
    await add_thermostat(hass, {**BASE, "heaters": [HEATER], "coolers": [COOLER]})
    await call(hass, "set_hvac_mode", hvac_mode="heat_cool")
    await set_schedule(hass, slots_now(21))
    assert hass.states.get(ENTITY).attributes["cool_above"] == 23

    set_temps(hass, 20)
    await hass.async_block_till_done()
    assert (hass.states.get(HEATER).state, hass.states.get(COOLER).state) == ("on", "off")
    set_temps(hass, 22)  # between heat stop (21.3) and cool start (23.3): idle
    await hass.async_block_till_done()
    assert (hass.states.get(HEATER).state, hass.states.get(COOLER).state) == ("off", "off")
    set_temps(hass, 23.4)
    await hass.async_block_till_done()
    assert (hass.states.get(HEATER).state, hass.states.get(COOLER).state) == ("off", "on")


async def test_ac_heats_and_cools(hass, freezer):
    await base_setup(hass, freezer, with_ac=True)
    await add_thermostat(hass, {**BASE, "climate_devices": [AC]})
    assert hass.states.get(ENTITY).attributes["hvac_modes"] == [
        HVACMode.HEAT, HVACMode.COOL, HVACMode.HEAT_COOL, HVACMode.OFF,
    ]
    await set_schedule(hass, slots_now(21))  # 19.2° < 21°: AC heats at 21
    ac = hass.states.get(AC)
    assert ac.state == HVACMode.HEAT
    assert ac.attributes["temperature"] == 21
    assert hass.states.get(ENTITY).attributes["hvac_action"] == HVACAction.HEATING

    set_temps(hass, 21.5)
    await hass.async_block_till_done()
    assert hass.states.get(AC).state == HVACMode.OFF

    await call(hass, "set_hvac_mode", hvac_mode="cool")
    set_temps(hass, 22)
    await hass.async_block_till_done()
    ac = hass.states.get(AC)
    assert (ac.state, ac.attributes["temperature"]) == (HVACMode.COOL, 21)

    await call(hass, "set_temperature", temperature=23)  # override: AC setpoint follows
    assert hass.states.get(AC).state == HVACMode.OFF  # 22° is already below 23° − margin
    set_temps(hass, 23.5)
    await hass.async_block_till_done()
    ac = hass.states.get(AC)
    assert (ac.state, ac.attributes["temperature"]) == (HVACMode.COOL, 23)


async def test_invalid_schedule_rejected(hass, thermostat):
    bad = {"daily": [{"title": "A", "start": "07:00", "end": "09:00", "temp": 21}, {"title": "B", "start": "08:00", "end": "10:00", "temp": 21}]}
    with pytest.raises(Exception, match="overlaps"):
        await set_schedule(hass, bad)


async def test_websocket(hass, thermostat, hass_ws_client):
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "slot_thermostat/schedule/set", "entity_id": ENTITY, "schedule": slots_now(21)})
    res = await client.receive_json()
    assert res["success"], res
    assert res["result"]["schedule"]["daily"][0]["title"] == "Now"
    await client.send_json_auto_id({"type": "slot_thermostat/schedule/get", "entity_id": ENTITY})
    res = await client.receive_json()
    assert res["result"]["min_temp"] == 5
    await client.send_json_auto_id({"type": "slot_thermostat/schedule/set", "entity_id": ENTITY, "schedule": {"mode": "x"}})
    res = await client.receive_json()
    assert not res["success"] and res["error"]["code"] == "invalid_schedule"


async def test_state_survives_reload(hass, thermostat):
    await set_schedule(hass, slots_now(21))
    await call(hass, "set_preset_mode", preset_mode="manual")
    await hass.config_entries.async_reload(thermostat.entry_id)
    await hass.async_block_till_done()
    state = hass.states.get(ENTITY)
    assert state.attributes["active_slot"] == "Now"


async def test_multiple_thermostats(hass, freezer):
    """Each config entry is its own thermostat with its own devices and schedule."""
    await base_setup(hass, freezer)
    set_temps(hass, 19)
    hass.states.async_set("sensor.bedroom", "22", {"unit_of_measurement": "°C"})
    await add_thermostat(hass, HEAT_ONLY)
    await add_thermostat(
        hass,
        {**BASE, "temperature_sensors": ["sensor.bedroom"], "heaters": ["input_boolean.heater_2"], "window_sensors": []},
        title="Bedroom",
    )
    await set_schedule(hass, slots_now(21))
    await set_schedule(hass, slots_now(20), entity="climate.bedroom")
    assert hass.states.get("climate.living").attributes["temperature"] == 21
    assert hass.states.get("climate.bedroom").attributes["temperature"] == 20
    assert hass.states.get(HEATER).state == "on"
    assert hass.states.get("input_boolean.heater_2").state == "off"


async def test_config_flow(hass):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.MENU
    assert result["menu_options"] == ["thermostat", "boiler"]
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "thermostat"})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"name": "Bedroom", **BASE})
    assert result["errors"] == {"base": "no_devices"}
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {"name": "Bedroom", **HEAT_ONLY, "heat_cool_gap": 0.1}
    )
    assert result["errors"] == {"heat_cool_gap": "gap_too_small"}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"name": "Bedroom", **HEAT_ONLY})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Bedroom"
    assert result["options"]["heaters"] == [HEATER]


async def test_options_flow_schedule(hass, thermostat):
    """Configure → Schedule → type → table with add / edit / remove → Save."""
    opts = hass.config_entries.options
    flow = await opts.async_init(thermostat.entry_id)
    assert flow["type"] is FlowResultType.MENU
    assert flow["menu_options"] == ["settings", "schedule"]
    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "schedule"})
    assert flow["step_id"] == "schedule"

    flow = await opts.async_configure(flow["flow_id"], {"mode": "daily"})
    assert flow["type"] is FlowResultType.MENU and flow["step_id"] == "slots"
    assert "No slots yet" in flow["description_placeholders"]["slots"]
    assert list(flow["menu_options"]) == ["add_slot", "save"]

    now = slots_now(21)["daily"][0]
    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "add_slot"})
    assert flow["step_id"] == "slot_form"
    flow = await opts.async_configure(
        flow["flow_id"], {"title": "Now", "start": now["start"] + ":00", "end": now["end"] + ":00", "temp": 21}
    )
    assert flow["step_id"] == "slots"
    table = flow["description_placeholders"]["slots"]
    assert "| Title | Start | End | Temp |" in table and f"| Now | {now['start']} | {now['end']} | 21° |" in table

    # an overlapping slot is rejected on the slot form itself
    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "add_slot"})
    flow = await opts.async_configure(
        flow["flow_id"], {"title": "Clash", "start": now["start"] + ":00", "end": now["end"] + ":00", "temp": 20}
    )
    assert flow["step_id"] == "slot_form" and flow["errors"] == {"base": "invalid_schedule"}
    assert "overlaps" in flow["description_placeholders"]["error"]
    flow = await opts.async_configure(
        flow["flow_id"], {"title": "Night", "start": "23:00:00", "end": "05:00:00", "temp": 19}
    )
    assert flow["step_id"] == "slots"

    # edit, then remove
    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "edit_slot"})
    flow = await opts.async_configure(flow["flow_id"], {"slot": "0"})
    assert flow["step_id"] == "slot_form"
    flow = await opts.async_configure(
        flow["flow_id"], {"title": "Now", "start": now["start"] + ":00", "end": now["end"] + ":00", "temp": 22}
    )
    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "remove_slot"})
    flow = await opts.async_configure(flow["flow_id"], {"slots": ["1"]})
    assert "Night" not in flow["description_placeholders"]["slots"]

    assert hass.states.get(HEATER).state == "off"  # nothing applied before Save
    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "save"})
    assert flow["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    state = hass.states.get(ENTITY)
    assert (state.attributes["active_slot"], state.attributes["temperature"]) == ("Now", 22)
    assert hass.states.get(HEATER).state == "on"


async def test_options_flow_weekly(hass, thermostat):
    opts = hass.config_entries.options
    await set_schedule(hass, slots_now(21))
    flow = await opts.async_init(thermostat.entry_id)
    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "schedule"})
    flow = await opts.async_configure(flow["flow_id"], {"mode": "weekly"})
    assert flow["step_id"] == "days"
    assert flow["menu_options"]["day_mon"] == "Monday · 1 slot"  # pre-filled from every-day

    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "day_sat"})
    assert flow["description_placeholders"]["day"] == "Saturday"
    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "remove_slot"})
    flow = await opts.async_configure(flow["flow_id"], {"slots": ["0"]})
    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "days"})
    assert flow["menu_options"]["day_sat"] == "Saturday · no slots"

    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "copy_day"})
    flow = await opts.async_configure(flow["flow_id"], {"from_day": "sat", "to_days": ["wed", "sun"]})
    assert flow["menu_options"]["day_wed"] == "Wednesday · no slots"
    flow = await opts.async_configure(flow["flow_id"], {"next_step_id": "save"})
    assert flow["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    state = hass.states.get(ENTITY)
    assert state.attributes["schedule_mode"] == "weekly"
    assert state.attributes["active_slot"] is None  # Wednesday now has no slots


async def test_options_flow_settings(hass, thermostat):
    flow = await hass.config_entries.options.async_init(thermostat.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "settings"})
    assert flow["step_id"] == "settings"
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {**HEAT_ONLY, "start_margin": 1})
    assert flow["type"] is FlowResultType.CREATE_ENTRY
    assert thermostat.options["start_margin"] == 1


async def test_user_change_takes_effect_now(hass, freezer):
    """Lowering the target below the room temperature stops at once (no margin, no min cycle)."""
    await base_setup(hass, freezer)
    await add_thermostat(hass, {**HEAT_ONLY, "min_cycle_minutes": 5})
    set_temps(hass, 23.6)
    await call(hass, "set_preset_mode", preset_mode="manual")
    await call(hass, "set_temperature", temperature=24)  # 23.6 < 24: starts right away
    assert hass.states.get(HEATER).state == "on"

    await call(hass, "set_temperature", temperature=23.5)  # just under the room: stop now
    assert hass.states.get(HEATER).state == "off"

    await call(hass, "set_temperature", temperature=23.8)  # starting again respects min off time
    assert hass.states.get(HEATER).state == "off"
    assert "minimum cycle" in hass.states.get(ENTITY).attributes["reason"]

    # Without user changes the margins apply as before
    freezer.tick(timedelta(minutes=5, seconds=31))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off"  # 23.6 is within 23.8 − 0.3
    set_temps(hass, 23.5)
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "on"
    set_temps(hass, 23.9)  # above target but inside the stop margin: keeps heating
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "on"


async def test_status_text(hass, thermostat):
    assert hass.states.get(ENTITY).attributes["status"] == "No slots scheduled"
    await set_schedule(hass, slots_now(21))
    assert hass.states.get(ENTITY).attributes["status"] == "Now · 21° · until 14:00"
    await call(hass, "set_temperature", temperature=22.5)
    assert hass.states.get(ENTITY).attributes["status"] == "Override 22.5° · until 14:00"
    await call(hass, "set_preset_mode", preset_mode="manual")
    assert hass.states.get(ENTITY).attributes["status"].startswith("Manual · ")
