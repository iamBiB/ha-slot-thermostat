"""Config and options flow for Slot Thermostat."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_NAME
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    BooleanSelector,
    EntitySelector,
    EntitySelectorConfig,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    TimeSelector,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
)

from .const import (
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
    DEFAULT_MAX_TEMP,
    DEFAULT_MIN_CYCLE,
    DEFAULT_MIN_TEMP,
    DEFAULT_START_MARGIN,
    DEFAULT_STOP_MARGIN,
    DEFAULT_TEMP_STEP,
    DOMAIN,
    CONF_ENTRY_TYPE,
    CONF_ENFORCE_OFF,
    CONF_KEEP_ALIVE,
    CONF_MAX_RUN,
    CONF_NOTIFY,
    CONF_REST,
    CONF_SWITCH,
    DEFAULT_KEEP_ALIVE,
    DEFAULT_MAX_RUN,
    DEFAULT_REST,
    ENTRY_TYPE_BOILER,
)
from .schedule import DAYS, ScheduleError, normalize_schedule

DAY_NAMES = {
    "mon": "Monday",
    "tue": "Tuesday",
    "wed": "Wednesday",
    "thu": "Thursday",
    "fri": "Friday",
    "sat": "Saturday",
    "sun": "Sunday",
}


def _number(min_: float, max_: float, step: float, unit: str) -> NumberSelector:
    return NumberSelector(
        NumberSelectorConfig(
            min=min_, max=max_, step=step, unit_of_measurement=unit, mode=NumberSelectorMode.BOX
        )
    )


def _schema(include_name: bool) -> vol.Schema:
    fields: dict[Any, Any] = {}
    if include_name:
        fields[vol.Required(CONF_NAME)] = TextSelector()
    fields.update(
        {
            vol.Required(CONF_SENSORS): EntitySelector(
                EntitySelectorConfig(domain="sensor", multiple=True)
            ),
            vol.Optional(CONF_HEATERS): EntitySelector(
                EntitySelectorConfig(domain=["switch", "input_boolean"], multiple=True)
            ),
            vol.Optional(CONF_COOLERS): EntitySelector(
                EntitySelectorConfig(domain=["switch", "input_boolean"], multiple=True)
            ),
            vol.Optional(CONF_CLIMATES): EntitySelector(
                EntitySelectorConfig(domain="climate", multiple=True)
            ),
            vol.Optional(CONF_WINDOWS): EntitySelector(
                EntitySelectorConfig(domain="binary_sensor", multiple=True)
            ),
            vol.Required(CONF_START_MARGIN, default=DEFAULT_START_MARGIN): _number(0, 5, 0.1, "°"),
            vol.Required(CONF_STOP_MARGIN, default=DEFAULT_STOP_MARGIN): _number(0, 5, 0.1, "°"),
            vol.Required(CONF_COOL_OFFSET, default=DEFAULT_COOL_OFFSET): _number(0, 10, 0.5, "°"),
            vol.Required(CONF_MIN_CYCLE, default=DEFAULT_MIN_CYCLE): _number(0, 60, 1, "min"),
            vol.Required(CONF_MIN_TEMP, default=DEFAULT_MIN_TEMP): _number(0, 40, 0.5, "°"),
            vol.Required(CONF_MAX_TEMP, default=DEFAULT_MAX_TEMP): _number(5, 50, 0.5, "°"),
            vol.Required(CONF_TEMP_STEP, default=DEFAULT_TEMP_STEP): SelectSelector(
                SelectSelectorConfig(options=["0.1", "0.5", "1"], mode=SelectSelectorMode.DROPDOWN)
            ),
        }
    )
    return vol.Schema(fields)


def _validate(user_input: dict[str, Any]) -> dict[str, str]:
    errors: dict[str, str] = {}
    sensors = set(user_input.get(CONF_SENSORS) or [])
    devices = [
        *(user_input.get(CONF_HEATERS) or []),
        *(user_input.get(CONF_COOLERS) or []),
        *(user_input.get(CONF_CLIMATES) or []),
    ]
    if not sensors:
        errors[CONF_SENSORS] = "required"
    if not devices:
        errors["base"] = "no_devices"
    elif sensors & set(devices):
        errors["base"] = "device_is_sensor"
    elif set(user_input.get(CONF_HEATERS) or []) & set(user_input.get(CONF_COOLERS) or []):
        errors["base"] = "heater_is_cooler"
    if float(user_input[CONF_MIN_TEMP]) >= float(user_input[CONF_MAX_TEMP]):
        errors[CONF_MAX_TEMP] = "max_below_min"
    if float(user_input[CONF_COOL_OFFSET]) < float(user_input[CONF_STOP_MARGIN]):
        errors[CONF_COOL_OFFSET] = "gap_too_small"
    return errors


class SlotThermostatConfigFlow(ConfigFlow, domain=DOMAIN):
    """Create a Slot Thermostat."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Thermostat or shared device?"""
        return self.async_show_menu(step_id="user", menu_options=["thermostat", "boiler"])

    async def async_step_thermostat(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Ask for name, sensors, devices and tuning."""
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(user_input)
            if not errors:
                options = dict(user_input)
                name = options.pop(CONF_NAME)
                return self.async_create_entry(title=name, data={}, options=options)
        return self.async_show_form(
            step_id="thermostat",
            data_schema=self.add_suggested_values_to_schema(_schema(True), user_input or {}),
            errors=errors,
        )

    async def async_step_boiler(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """A switch or AC shared by several thermostats."""
        if user_input is not None:
            options = dict(user_input)
            name = options.pop(CONF_NAME)
            await self.async_set_unique_id(f"boiler_{options[CONF_SWITCH]}")
            self._abort_if_unique_id_configured()
            return self.async_create_entry(
                title=name, data={CONF_ENTRY_TYPE: ENTRY_TYPE_BOILER}, options=options
            )
        return self.async_show_form(
            step_id="boiler",
            data_schema=self.add_suggested_values_to_schema(_boiler_schema(True), {}),
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: Any) -> OptionsFlow:
        """Options flow: thermostat (devices, tuning, schedule) or shared device."""
        if config_entry.data.get(CONF_ENTRY_TYPE) == ENTRY_TYPE_BOILER:
            return BoilerOptionsFlow()
        return SlotThermostatOptionsFlow()


def _boiler_schema(include_name: bool) -> vol.Schema:
    fields: dict[Any, Any] = {}
    if include_name:
        fields[vol.Required(CONF_NAME)] = TextSelector()
        fields[vol.Required(CONF_SWITCH)] = EntitySelector(
            EntitySelectorConfig(domain=["switch", "input_boolean", "climate"])
        )
    fields.update(
        {
            vol.Required(CONF_KEEP_ALIVE, default=DEFAULT_KEEP_ALIVE): _number(0, 60, 1, "min"),
            vol.Required(CONF_MAX_RUN, default=DEFAULT_MAX_RUN): _number(0, 1440, 5, "min"),
            vol.Required(CONF_REST, default=DEFAULT_REST): _number(0, 120, 1, "min"),
            vol.Required(CONF_ENFORCE_OFF, default=True): BooleanSelector(),
            vol.Required(CONF_NOTIFY, default=True): BooleanSelector(),
        }
    )
    return vol.Schema(fields)


class BoilerOptionsFlow(OptionsFlow):
    """Edit a shared device's protection settings."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Keep-alive, max run time, rest, turn-off rule and notifications."""
        if user_input is not None:
            return self.async_create_entry(
                data={CONF_SWITCH: self.config_entry.options[CONF_SWITCH], **user_input}
            )
        return self.async_show_form(
            step_id="init",
            data_schema=self.add_suggested_values_to_schema(
                _boiler_schema(False), dict(self.config_entry.options)
            ),
        )


def _fmt_temp(temp: Any) -> str:
    return f"{float(temp):g}°"


def _fmt_end(slot: dict[str, Any]) -> str:
    if slot["end"] in ("00:00", "24:00"):
        return "24:00"
    return f"{slot['end']} (+1)" if slot["end"] <= slot["start"] else slot["end"]


def _slot_table(slots: list[dict[str, Any]]) -> str:
    """Markdown table of slots for the step description."""
    if not slots:
        return "_No slots yet. Heating and cooling stay off all day._"
    rows = "\n".join(
        f"| {s['title'] or '–'} | {s['start']} | {_fmt_end(s)} | {_fmt_temp(s['temp'])} |"
        for s in slots
    )
    return f"| Title | Start | End | Temp |\n|---|---|---|---|\n{rows}"


def _slot_choice(index: int, slot: dict[str, Any]) -> dict[str, str]:
    label = f"{slot['title'] or 'Slot'} · {slot['start']}–{_fmt_end(slot)} · {_fmt_temp(slot['temp'])}"
    return {"value": str(index), "label": label}


def _hhmmss(value: str) -> str:
    if value == "24:00":  # the time picker can't show 24:00; 23:59 is read back as midnight
        return "23:59:00"
    return value if value.count(":") == 2 else f"{value}:00"


class SlotThermostatOptionsFlow(OptionsFlow):
    """Edit an existing Slot Thermostat: its devices and tuning, or its schedule.

    Schedule editing is a small wizard: pick the schedule type, then add, edit
    or remove slots from a table, and save. Nothing is applied until Save.
    """

    _draft: dict[str, Any]
    _day: str  # "daily" or mon…sun
    _edit_index: int | None = None
    _error: str = ""

    # ------------------------------------------------------------- menu

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Choose what to edit."""
        return self.async_show_menu(step_id="init", menu_options=["settings", "schedule"])

    async def async_step_settings(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Sensors, devices and tuning (same fields as setup, without the name)."""
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(user_input)
            if not errors:
                return self.async_create_entry(data=user_input)
        return self.async_show_form(
            step_id="settings",
            data_schema=self.add_suggested_values_to_schema(
                _schema(False), user_input or dict(self.config_entry.options)
            ),
            errors=errors,
        )

    # --------------------------------------------------------- schedule

    def _limits(self) -> tuple[float, float]:
        options = self.config_entry.options
        return (
            float(options.get(CONF_MIN_TEMP, DEFAULT_MIN_TEMP)),
            float(options.get(CONF_MAX_TEMP, DEFAULT_MAX_TEMP)),
        )

    def _slots(self) -> list[dict[str, Any]]:
        return self._draft["daily"] if self._day == "daily" else self._draft["weekly"][self._day]

    def _try(self, draft: dict[str, Any]) -> str:
        """Validate a draft; keep it (sorted, normalized) if valid. Returns an error or ''."""
        try:
            self._draft = normalize_schedule(draft, *self._limits())
        except ScheduleError as err:
            return str(err)
        return ""

    async def async_step_schedule(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Step 1: every day or per weekday."""
        current = self.config_entry.runtime_data.schedule
        if user_input is not None:
            self._draft = {**current, "weekly": dict(current["weekly"]), "mode": user_input["mode"]}
            if user_input["mode"] == "daily":
                self._day = "daily"
                return await self.async_step_slots()
            if not any(self._draft["weekly"].values()) and self._draft["daily"]:
                # First time per weekday: start every day from the every-day slots.
                self._draft["weekly"] = {day: list(self._draft["daily"]) for day in DAYS}
            return await self.async_step_days()
        return self.async_show_form(
            step_id="schedule",
            data_schema=self.add_suggested_values_to_schema(
                vol.Schema(
                    {
                        vol.Required("mode"): SelectSelector(
                            SelectSelectorConfig(
                                options=["daily", "weekly"],
                                mode=SelectSelectorMode.LIST,
                                translation_key="schedule_mode",
                            )
                        )
                    }
                ),
                {"mode": current["mode"]},
            ),
        )

    async def async_step_days(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Per weekday: pick a day to edit, copy a day, or save."""
        def count(day: str) -> str:
            n = len(self._draft["weekly"][day])
            return "no slots" if n == 0 else "1 slot" if n == 1 else f"{n} slots"

        options = {f"day_{day}": f"{name} · {count(day)}" for day, name in DAY_NAMES.items()}
        options["copy_day"] = "Copy a day to other days…"
        options["save"] = "Save schedule"
        return self.async_show_menu(step_id="days", menu_options=options)

    async def _async_open_day(self, day: str) -> ConfigFlowResult:
        self._day = day
        return await self.async_step_slots()

    async def async_step_day_mon(self, user_input: Any = None) -> ConfigFlowResult:
        """Edit Monday."""
        return await self._async_open_day("mon")

    async def async_step_day_tue(self, user_input: Any = None) -> ConfigFlowResult:
        """Edit Tuesday."""
        return await self._async_open_day("tue")

    async def async_step_day_wed(self, user_input: Any = None) -> ConfigFlowResult:
        """Edit Wednesday."""
        return await self._async_open_day("wed")

    async def async_step_day_thu(self, user_input: Any = None) -> ConfigFlowResult:
        """Edit Thursday."""
        return await self._async_open_day("thu")

    async def async_step_day_fri(self, user_input: Any = None) -> ConfigFlowResult:
        """Edit Friday."""
        return await self._async_open_day("fri")

    async def async_step_day_sat(self, user_input: Any = None) -> ConfigFlowResult:
        """Edit Saturday."""
        return await self._async_open_day("sat")

    async def async_step_day_sun(self, user_input: Any = None) -> ConfigFlowResult:
        """Edit Sunday."""
        return await self._async_open_day("sun")

    async def async_step_slots(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """The table of slots with add / edit / remove."""
        slots = self._slots()
        options = {"add_slot": "Add slot"}
        if slots:
            options["edit_slot"] = "Edit a slot"
            options["remove_slot"] = "Remove a slot"
        if self._day == "daily":
            options["save"] = "Save schedule"
        else:
            options["days"] = "Back to days"
        return self.async_show_menu(
            step_id="slots",
            menu_options=options,
            description_placeholders={
                "day": "Every day" if self._day == "daily" else DAY_NAMES[self._day],
                "slots": _slot_table(slots),
            },
        )

    async def async_step_add_slot(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Add a slot."""
        self._edit_index = None
        return await self.async_step_slot_form()

    async def async_step_edit_slot(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Pick which slot to edit."""
        if user_input is not None:
            self._edit_index = int(user_input["slot"])
            return await self.async_step_slot_form()
        return self.async_show_form(
            step_id="edit_slot",
            data_schema=vol.Schema(
                {
                    vol.Required("slot"): SelectSelector(
                        SelectSelectorConfig(
                            options=[_slot_choice(i, s) for i, s in enumerate(self._slots())],
                            mode=SelectSelectorMode.LIST,
                        )
                    )
                }
            ),
        )

    async def async_step_slot_form(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Title, start, end and temperature of one slot."""
        errors: dict[str, str] = {}
        placeholders = {"error": ""}
        if user_input is not None:
            slot = {
                "title": (user_input.get("title") or "").strip(),
                "start": user_input["start"],
                "end": user_input["end"],
                "temp": user_input["temp"],
            }
            draft = {**self._draft, "weekly": dict(self._draft["weekly"])}
            slots = list(self._slots())
            if self._edit_index is None:
                slots.append(slot)
            else:
                slots[self._edit_index] = slot
            if self._day == "daily":
                draft["daily"] = slots
            else:
                draft["weekly"][self._day] = slots
            if not (error := self._try(draft)):
                return await self.async_step_slots()
            errors["base"] = "invalid_schedule"
            placeholders["error"] = error
            suggested = user_input
        elif self._edit_index is not None:
            current = self._slots()[self._edit_index]
            suggested = {**current, "start": _hhmmss(current["start"]), "end": _hhmmss(current["end"])}
        else:
            slots = self._slots()
            start = slots[-1]["end"] if slots else "07:00"
            suggested = {"start": _hhmmss(start), "temp": slots[-1]["temp"] if slots else 21}
        low, high = self._limits()
        step = float(self.config_entry.options.get(CONF_TEMP_STEP, DEFAULT_TEMP_STEP))
        return self.async_show_form(
            step_id="slot_form",
            data_schema=self.add_suggested_values_to_schema(
                vol.Schema(
                    {
                        vol.Optional("title"): TextSelector(),
                        vol.Required("start"): TimeSelector(),
                        vol.Required("end"): TimeSelector(),
                        vol.Required("temp"): _number(low, high, step, "°"),
                    }
                ),
                suggested,
            ),
            errors=errors,
            description_placeholders=placeholders,
        )

    async def async_step_remove_slot(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Remove one or more slots."""
        if user_input is not None:
            remove = {int(i) for i in user_input.get("slots", [])}
            slots = [s for i, s in enumerate(self._slots()) if i not in remove]
            if self._day == "daily":
                self._draft["daily"] = slots
            else:
                self._draft["weekly"][self._day] = slots
            return await self.async_step_slots()
        return self.async_show_form(
            step_id="remove_slot",
            data_schema=vol.Schema(
                {
                    vol.Optional("slots"): SelectSelector(
                        SelectSelectorConfig(
                            options=[_slot_choice(i, s) for i, s in enumerate(self._slots())],
                            multiple=True,
                            mode=SelectSelectorMode.LIST,
                        )
                    )
                }
            ),
        )

    async def async_step_copy_day(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Copy one day's slots to other days."""
        errors: dict[str, str] = {}
        placeholders = {"error": ""}
        if user_input is not None:
            weekly = dict(self._draft["weekly"])
            for day in user_input.get("to_days", []):
                weekly[day] = list(weekly[user_input["from_day"]])
            if not (error := self._try({**self._draft, "weekly": weekly})):
                return await self.async_step_days()
            errors["base"] = "invalid_schedule"
            placeholders["error"] = error
        days = [{"value": day, "label": name} for day, name in DAY_NAMES.items()]
        return self.async_show_form(
            step_id="copy_day",
            errors=errors,
            description_placeholders=placeholders,
            data_schema=vol.Schema(
                {
                    vol.Required("from_day", default="mon"): SelectSelector(
                        SelectSelectorConfig(options=days, mode=SelectSelectorMode.DROPDOWN)
                    ),
                    vol.Optional("to_days"): SelectSelector(
                        SelectSelectorConfig(options=days, multiple=True, mode=SelectSelectorMode.LIST)
                    ),
                }
            ),
        )

    async def async_step_save(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Apply the schedule and finish."""
        if error := self._try(self._draft):  # pragma: no cover - drafts are validated as edited
            raise ScheduleError(error)
        entity = next(
            (
                ent
                for ent in self.hass.data.get(DOMAIN, {}).get("entities", {}).values()
                if ent.entry_id == self.config_entry.entry_id
            ),
            None,
        )
        if entity is not None:
            await entity.async_set_schedule(self._draft)
        else:  # thermostat not running (e.g. disabled): just store it
            data = self.config_entry.runtime_data
            data.schedule = self._draft
            await data.store.async_save(self._draft)
        # Options are unchanged, so the entry is not reloaded.
        return self.async_create_entry(data=dict(self.config_entry.options))
