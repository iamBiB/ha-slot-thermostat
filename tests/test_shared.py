"""Shared switches and the Shared heater (boiler) entry."""

from datetime import timedelta

from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from custom_components.slot_thermostat.const import DOMAIN

from .test_climate import BASE, HEATER, add_thermostat, base_setup, set_schedule, slots_now

LIVING_SENSOR = "sensor.living"
BED_SENSOR = "sensor.bed"
STATUS = "sensor.boiler_status"


def temps(hass: HomeAssistant, living: float, bed: float) -> None:
    hass.states.async_set(LIVING_SENSOR, str(living), {"unit_of_measurement": "°C"})
    hass.states.async_set(BED_SENSOR, str(bed), {"unit_of_measurement": "°C"})


def room(sensor: str) -> dict:
    return {**BASE, "temperature_sensors": [sensor], "window_sensors": [], "heaters": [HEATER]}


async def two_rooms(hass, freezer, with_boiler: dict | None = None):
    await base_setup(hass, freezer)
    temps(hass, 20, 20)
    if with_boiler is not None:
        entry = MockConfigEntry(
            domain=DOMAIN,
            title="Boiler",
            data={"entry_type": "boiler"},
            options={"switch": HEATER, "keep_alive_minutes": 0, "max_run_minutes": 0, "rest_minutes": 10, "notify": True, **with_boiler},
        )
        entry.add_to_hass(hass)
        assert await hass.config_entries.async_setup(entry.entry_id)
    await add_thermostat(hass, room(LIVING_SENSOR), title="Living")
    await add_thermostat(hass, room(BED_SENSOR), title="Bedroom")
    await set_schedule(hass, slots_now(21), entity="climate.living")
    await set_schedule(hass, slots_now(21), entity="climate.bedroom")
    await hass.async_block_till_done()


async def test_shared_switch_stays_on_until_last_room_is_warm(hass, freezer):
    await two_rooms(hass, freezer)
    assert hass.states.get(HEATER).state == "on"

    temps(hass, 21.5, 20)  # living warm, bedroom still cold
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "on"
    assert hass.states.get("climate.living").attributes["hvac_action"] == "idle"
    assert hass.states.get("climate.bedroom").attributes["hvac_action"] == "heating"

    temps(hass, 21.5, 21.5)  # both warm
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off"

    temps(hass, 20, 21.5)  # living cold again
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "on"
    # turning one thermostat off doesn't stop the other's heat
    temps(hass, 20, 20)
    await hass.async_block_till_done()
    await hass.services.async_call("climate", "turn_off", {"entity_id": "climate.living"}, blocking=True)
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "on"


async def test_shared_switch_survives_thermostat_removal(hass, freezer):
    await two_rooms(hass, freezer)
    living = next(e for e in hass.config_entries.async_entries(DOMAIN) if e.title == "Living")
    temps(hass, 21.5, 20)
    await hass.async_block_till_done()
    await hass.config_entries.async_unload(living.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "on"  # bedroom still needs it
    temps(hass, 21.5, 21.5)
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off"


async def test_one_thermostat_many_devices_move_together(hass, freezer):
    await base_setup(hass, freezer)
    temps(hass, 20, 20)
    await add_thermostat(
        hass,
        {**BASE, "temperature_sensors": [LIVING_SENSOR, BED_SENSOR], "window_sensors": [], "heaters": [HEATER, "input_boolean.heater_2"]},
    )
    await set_schedule(hass, slots_now(21))
    assert hass.states.get(HEATER).state == "on" and hass.states.get("input_boolean.heater_2").state == "on"
    temps(hass, 22, 20.5)  # average 21.25 < 21.3: one sensor warm doesn't stop anything
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "on" and hass.states.get("input_boolean.heater_2").state == "on"
    temps(hass, 22, 21)  # average 21.5: room done, all off together
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off" and hass.states.get("input_boolean.heater_2").state == "off"


async def test_boiler_status_and_run_stats(hass, freezer):
    await two_rooms(hass, freezer, with_boiler={})
    state = hass.states.get(STATUS)
    assert state.state == "heating"
    assert state.attributes["requested_by"] == ["Bedroom", "Living"]

    freezer.tick(timedelta(minutes=25))
    temps(hass, 21.5, 21.5)
    await hass.async_block_till_done()
    state = hass.states.get(STATUS)
    assert state.state == "off"
    assert state.attributes["last_run_seconds"] == 25 * 60
    assert state.attributes["last_started_by"] == ["Bedroom", "Living"]


async def test_boiler_max_run_rests_then_resumes(hass, freezer):
    await two_rooms(hass, freezer, with_boiler={"max_run_minutes": 60, "rest_minutes": 10})
    assert hass.states.get(HEATER).state == "on"
    freezer.tick(timedelta(minutes=60, seconds=30))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off"
    assert hass.states.get(STATUS).state == "resting"
    for _ in range(2):  # a full thermostat tick (timers run slightly after the 30 s mark)
        freezer.tick(timedelta(seconds=31))
        async_fire_time_changed(hass)
        await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off"  # stays off while resting
    assert "Boiler resting" in hass.states.get("climate.living").attributes["reason"]

    freezer.tick(timedelta(minutes=10, seconds=30))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "on"  # rooms still cold: back on after the rest


async def test_boiler_fault_on_without_demand(hass, freezer):
    await two_rooms(hass, freezer, with_boiler={})
    temps(hass, 21.5, 21.5)
    await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off"
    await hass.services.async_call("input_boolean", "turn_on", {"entity_id": HEATER}, blocking=True)
    for _ in range(6):  # 3 minutes of ticks
        freezer.tick(timedelta(seconds=30))
        async_fire_time_changed(hass)
        await hass.async_block_till_done()
    assert hass.states.get(HEATER).state == "off"


async def test_boiler_keep_alive(hass, freezer):
    calls = []
    await two_rooms(hass, freezer, with_boiler={"keep_alive_minutes": 5})
    hass.bus.async_listen("call_service", lambda e: calls.append(e.data) if e.data.get("service") == "turn_on" else None)
    for _ in range(12):  # 6 minutes
        freezer.tick(timedelta(seconds=30))
        async_fire_time_changed(hass)
        await hass.async_block_till_done()
    assert any(HEATER in str(c.get("service_data")) for c in calls)


async def test_shutdown_turns_everything_off(hass, freezer):
    await two_rooms(hass, freezer)
    assert hass.states.get(HEATER).state == "on"
    await hass.async_stop(force=True)
    assert hass.states.get(HEATER).state == "off"


async def test_boiler_config_flow(hass):
    flow = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    flow = await hass.config_entries.flow.async_configure(flow["flow_id"], {"next_step_id": "boiler"})
    assert flow["step_id"] == "boiler"
    flow = await hass.config_entries.flow.async_configure(
        flow["flow_id"],
        {"name": "Boiler", "switch": HEATER, "keep_alive_minutes": 0, "max_run_minutes": 120, "rest_minutes": 10, "notify": True},
    )
    assert flow["type"] is FlowResultType.CREATE_ENTRY
    assert flow["data"] == {"entry_type": "boiler"}
    flow = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    flow = await hass.config_entries.flow.async_configure(flow["flow_id"], {"next_step_id": "boiler"})
    flow = await hass.config_entries.flow.async_configure(
        flow["flow_id"],
        {"name": "Again", "switch": HEATER, "keep_alive_minutes": 0, "max_run_minutes": 120, "rest_minutes": 10, "notify": True},
    )
    assert flow["type"] is FlowResultType.ABORT and flow["reason"] == "already_configured"


async def shared_ac(hass, freezer, with_device: bool = False):
    from .test_climate import AC

    await base_setup(hass, freezer, with_ac=True)
    temps(hass, 20, 20)
    if with_device:
        entry = MockConfigEntry(
            domain=DOMAIN, title="Ducted AC", data={"entry_type": "boiler"},
            options={"switch": AC, "keep_alive_minutes": 0, "max_run_minutes": 0, "rest_minutes": 10, "notify": True, "enforce_off": True},
        )
        entry.add_to_hass(hass)
        assert await hass.config_entries.async_setup(entry.entry_id)
    for title, sensor in (("Living", LIVING_SENSOR), ("Bedroom", BED_SENSOR)):
        await add_thermostat(
            hass, {**BASE, "temperature_sensors": [sensor], "window_sensors": [], "climate_devices": [AC]}, title=title
        )
    return AC


async def test_shared_ac_first_request_wins(hass, freezer):
    ac = await shared_ac(hass, freezer, with_device=True)
    await hass.services.async_call("climate", "set_hvac_mode", {"entity_id": "climate.bedroom", "hvac_mode": "cool"}, blocking=True)
    temps(hass, 19, 27)
    await set_schedule(hass, slots_now(21), entity="climate.living")  # living asks for heat first
    await set_schedule(hass, slots_now(24), entity="climate.bedroom")  # bedroom then asks for cooling
    state = hass.states.get(ac)
    assert (state.state, state.attributes["temperature"]) == ("heat", 21)
    assert hass.states.get("climate.living").attributes["hvac_action"] == "heating"
    bed = hass.states.get("climate.bedroom").attributes
    assert bed["hvac_action"] == "idle"
    assert "Ducted AC is heating for Living" in bed["reason"]
    status = hass.states.get("sensor.ducted_ac_status")
    assert status.state == "heating"
    assert (status.attributes["requested_by"], status.attributes["waiting"]) == (["Living"], ["Bedroom"])

    temps(hass, 21.5, 27)  # living satisfied: the AC switches to cooling for the bedroom
    await hass.async_block_till_done()
    state = hass.states.get(ac)
    assert (state.state, state.attributes["temperature"]) == ("cool", 24)
    assert hass.states.get("climate.bedroom").attributes["hvac_action"] == "cooling"
    assert hass.states.get("sensor.ducted_ac_status").state == "cooling"

    temps(hass, 19, 26)  # living cold again, but cooling is running: it keeps cooling first
    await hass.async_block_till_done()
    assert hass.states.get(ac).state == "cool"
    temps(hass, 19, 23.5)  # bedroom done: back to heating for living
    await hass.async_block_till_done()
    assert hass.states.get(ac).state == "heat"


async def test_shared_ac_uses_highest_heat_target(hass, freezer):
    ac = await shared_ac(hass, freezer)
    temps(hass, 19, 19)
    await set_schedule(hass, slots_now(21), entity="climate.living")
    await set_schedule(hass, slots_now(23), entity="climate.bedroom")
    assert hass.states.get(ac).attributes["temperature"] == 23
    temps(hass, 19, 23.5)  # bedroom done: the AC drops to living's 21°
    await hass.async_block_till_done()
    assert (hass.states.get(ac).state, hass.states.get(ac).attributes["temperature"]) == ("heat", 21)
    temps(hass, 21.5, 23.5)
    await hass.async_block_till_done()
    assert hass.states.get(ac).state == "off"


async def test_shared_ac_manual_use_allowed_when_enforce_off_disabled(hass, freezer):
    ac = await shared_ac(hass, freezer)
    entry = MockConfigEntry(
        domain=DOMAIN, title="Ducted AC", data={"entry_type": "boiler"},
        options={"switch": ac, "keep_alive_minutes": 0, "max_run_minutes": 0, "rest_minutes": 10, "notify": False, "enforce_off": False},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.services.async_call("climate", "set_hvac_mode", {"entity_id": ac, "hvac_mode": "cool"}, blocking=True)
    for _ in range(6):
        freezer.tick(timedelta(seconds=31))
        async_fire_time_changed(hass)
        await hass.async_block_till_done()
    assert hass.states.get(ac).state == "cool"
