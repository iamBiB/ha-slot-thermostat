"""Constants for Slot Thermostat."""

from __future__ import annotations

DOMAIN = "slot_thermostat"

CONF_SENSORS = "temperature_sensors"
CONF_HEATERS = "heaters"
CONF_COOLERS = "coolers"
CONF_CLIMATES = "climate_devices"
CONF_COOL_OFFSET = "heat_cool_gap"
CONF_WINDOWS = "window_sensors"
CONF_START_MARGIN = "start_margin"
CONF_STOP_MARGIN = "stop_margin"
CONF_MIN_CYCLE = "min_cycle_minutes"
CONF_MIN_TEMP = "min_temp"
CONF_MAX_TEMP = "max_temp"
CONF_TEMP_STEP = "target_temp_step"

DEFAULT_START_MARGIN = 0.3
DEFAULT_STOP_MARGIN = 0.3
DEFAULT_MIN_CYCLE = 5
DEFAULT_COOL_OFFSET = 2.0
DEFAULT_MIN_TEMP = 5.0
DEFAULT_MAX_TEMP = 30.0
DEFAULT_TEMP_STEP = "0.5"
DEFAULT_MANUAL_TEMP = 20.0

PRESET_SCHEDULE = "schedule"
PRESET_MANUAL = "manual"

STORAGE_VERSION = 1

# Entry types: a thermostat (default) or a shared heater (boiler)
CONF_ENTRY_TYPE = "entry_type"
ENTRY_TYPE_THERMOSTAT = "thermostat"
ENTRY_TYPE_BOILER = "boiler"

CONF_SWITCH = "switch"
CONF_KEEP_ALIVE = "keep_alive_minutes"
CONF_MAX_RUN = "max_run_minutes"
CONF_REST = "rest_minutes"
CONF_NOTIFY = "notify"
CONF_ENFORCE_OFF = "enforce_off"
DEFAULT_KEEP_ALIVE = 0
DEFAULT_MAX_RUN = 120
DEFAULT_REST = 10

HEATER_CARD_URL = "/slot_thermostat/slot-heater-card.js"
HEATER_CARD_FILENAME = "slot-heater-card.js"

CARD_URL = "/slot_thermostat/slot-thermostat-card.js"
CARD_FILENAME = "slot-thermostat-card.js"
SCHEDULE_CARD_URL = "/slot_thermostat/slot-schedule-card.js"
SCHEDULE_CARD_FILENAME = "slot-schedule-card.js"

ATTR_SCHEDULE = "schedule"

SERVICE_SET_SCHEDULE = "set_schedule"
SERVICE_CLEAR_OVERRIDE = "clear_override"

WS_GET_SCHEDULE = "slot_thermostat/schedule/get"
WS_SET_SCHEDULE = "slot_thermostat/schedule/set"
