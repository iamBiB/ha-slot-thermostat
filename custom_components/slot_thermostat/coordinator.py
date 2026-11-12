"""Shared devices: several thermostats can drive the same switch or AC.

Every thermostat sends *requests* ("heat to 21°", "cool to 25°") to the devices
it uses. A device runs while at least one request is open:

- Switches turn on while anyone asks and off when nobody does.
- AC / climate devices follow "first request wins": they keep heating (or
  cooling) while any room still asks for that, then switch if the other side is
  waiting. Heating uses the highest requested target, cooling the lowest.

A Shared device entry adds protection for one device (keep-alive re-sends, a
maximum run time with a rest, turning it off when it runs with nobody asking)
and run statistics for its status sensor and card.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import logging
from typing import Any, Literal

from homeassistant.components import persistent_notification
from homeassistant.components.climate import (
    ATTR_HVAC_MODE,
    ATTR_HVAC_MODES,
    DOMAIN as CLIMATE_DOMAIN,
    SERVICE_SET_HVAC_MODE,
    SERVICE_SET_TEMPERATURE,
    HVACMode,
)
from homeassistant.const import (
    ATTR_ENTITY_ID,
    ATTR_TEMPERATURE,
    SERVICE_TURN_OFF,
    SERVICE_TURN_ON,
    STATE_OFF,
    STATE_ON,
    STATE_UNAVAILABLE,
    STATE_UNKNOWN,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

Direction = Literal["heat", "cool"]
FAULT_GRACE = timedelta(minutes=2)
NOT_RUNNING = {STATE_OFF, STATE_UNAVAILABLE, STATE_UNKNOWN}


@dataclass
class DeviceSettings:
    """Options of a Shared device entry."""

    name: str
    keep_alive: timedelta | None = None
    max_run: timedelta | None = None
    rest: timedelta = timedelta(minutes=10)
    notify: bool = True
    enforce_off: bool = True


@dataclass
class Request:
    """One thermostat asking a device for heat or cooling."""

    name: str
    direction: Direction
    target: float | None = None


@dataclass
class DeviceState:
    """What the manager knows about one shared device."""

    requests: dict[str, Request] = field(default_factory=dict)  # by thermostat, in request order
    settings: DeviceSettings | None = None
    active: Direction | None = None  # what the device is doing for the thermostats
    owned: bool = False  # we started it; only then do we turn it off when requests end
    running_since: datetime | None = None
    running_direction: Direction | None = None
    started_by: list[str] = field(default_factory=list)
    last_run: timedelta | None = None
    last_direction: Direction | None = None
    last_started_by: list[str] = field(default_factory=list)
    last_on: datetime | None = None
    last_off: datetime | None = None
    last_sent_on: datetime | None = None
    resting_until: datetime | None = None
    unexpected_on_since: datetime | None = None
    listeners: list[Callable[[], None]] = field(default_factory=list)


def is_climate(entity_id: str) -> bool:
    """AC / climate device rather than a switch."""
    return entity_id.startswith(f"{CLIMATE_DOMAIN}.")


class SharedDeviceManager:
    """Collects requests from thermostats and drives the devices."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.devices: dict[str, DeviceState] = {}

    def state(self, device: str) -> DeviceState:
        return self.devices.setdefault(device, DeviceState())

    # ---------------------------------------------------------- requests

    def is_resting(self, device: str) -> bool:
        until = self.state(device).resting_until
        return until is not None and dt_util.utcnow() < until

    def supports(self, device: str, direction: Direction) -> bool:
        """Can this device heat / cool? Switches: yes (their role is set by the thermostat)."""
        if not is_climate(device):
            return True
        state = self.hass.states.get(device)
        modes = state.attributes.get(ATTR_HVAC_MODES) if state else None
        # Unknown (e.g. unavailable at startup): assume a typical AC that does both.
        return True if not modes else direction in modes

    async def async_update(
        self,
        thermostat: str,
        name: str,
        heaters: list[str],
        coolers: list[str],
        climates: list[str],
        want: Direction | None,
        target: float | None,
    ) -> None:
        """Set this thermostat's requests on all its devices, then drive them."""
        for device in heaters:
            self._set(device, thermostat, Request(name, "heat") if want == "heat" else None)
        for device in coolers:
            self._set(device, thermostat, Request(name, "cool") if want == "cool" else None)
        for device in climates:
            ok = want is not None and target is not None and self.supports(device, want)
            self._set(device, thermostat, Request(name, want, target) if ok else None)
        await self.async_reconcile([*heaters, *coolers, *climates])

    def _set(self, device: str, thermostat: str, request: Request | None) -> None:
        requests = self.state(device).requests
        old = requests.get(thermostat)
        if request is None:
            requests.pop(thermostat, None)
        elif old is not None and old.direction == request.direction:
            old.target, old.name = request.target, request.name  # keep its place in line
        else:
            requests.pop(thermostat, None)
            requests[thermostat] = request  # new or changed direction: back of the line
        st = self.state(device)
        if request is not None and st.running_since is not None and request.name not in st.started_by:
            st.started_by = sorted([*st.started_by, request.name])

    async def async_release(self, thermostat: str) -> None:
        """A thermostat went away: drop all its requests."""
        touched = [d for d, st in self.devices.items() if st.requests.pop(thermostat, None)]
        await self.async_reconcile(touched)

    def _choose(self, st: DeviceState) -> tuple[Direction | None, float | None]:
        """First request wins: keep the current direction while anyone wants it."""
        directions = [r.direction for r in st.requests.values()]
        if not directions:
            return None, None
        direction = st.active if st.active in directions else directions[0]
        targets = [r.target for r in st.requests.values() if r.direction == direction and r.target is not None]
        target = (max(targets) if direction == "heat" else min(targets)) if targets else None
        return direction, target

    def serves(self, device: str, thermostat: str) -> bool:
        """Is the device running for this thermostat's request right now?"""
        st = self.state(device)
        request = st.requests.get(thermostat)
        state = self.hass.states.get(device)
        if request is None or state is None:
            return False
        if is_climate(device):
            return st.active == request.direction and state.state == request.direction
        return state.state == STATE_ON

    def waiting_reason(self, device: str, thermostat: str) -> str | None:
        """Why a request isn't served, e.g. "Ducted AC is cooling for Bedroom"."""
        st = self.state(device)
        request = st.requests.get(thermostat)
        if request is None:
            return None
        label = st.settings.name if st.settings else device
        if self.is_resting(device):
            return f"{label} resting"
        if is_climate(device) and st.active and st.active != request.direction:
            others = sorted(r.name for r in st.requests.values() if r.direction == st.active)
            verb = "heating" if st.active == "heat" else "cooling"
            return f"{label} is {verb} for {', '.join(others)}"
        return None

    async def async_reconcile(self, devices: list[str]) -> None:
        """Make each device match its requests (and its protection rules)."""
        now = dt_util.utcnow()
        for device in dict.fromkeys(devices):
            st = self.state(device)
            state = self.hass.states.get(device)
            if state is None or state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
                continue
            direction, target = self._choose(st)
            if self.is_resting(device):
                direction = None
            st.active = direction
            # Without requests we only turn off what we started: a device used by
            # hand is left alone (a Shared device can enforce "off" separately).
            if direction is None and not st.owned:
                self._notify(device)
                continue
            st.owned = direction is not None
            if is_climate(device):
                await self._async_drive_climate(device, state.state, state.attributes, direction, target)
            else:
                is_on = state.state == STATE_ON
                if direction and not is_on:
                    await self._async_switch(device, True)
                elif direction and st.settings and st.settings.keep_alive and (
                    st.last_sent_on is None or now - st.last_sent_on >= st.settings.keep_alive
                ):
                    await self._async_switch(device, True)
                elif not direction and is_on:
                    await self._async_switch(device, False)
            self._notify(device)

    async def _async_drive_climate(
        self, device: str, current: str, attrs: Any, direction: Direction | None, target: float | None
    ) -> None:
        try:
            if direction is None:
                if current != HVACMode.OFF:
                    await self.hass.services.async_call(
                        CLIMATE_DOMAIN, SERVICE_SET_HVAC_MODE,
                        {ATTR_ENTITY_ID: device, ATTR_HVAC_MODE: HVACMode.OFF}, blocking=True,
                    )
            elif current != direction or (target is not None and attrs.get(ATTR_TEMPERATURE) != target):
                data: dict[str, Any] = {ATTR_ENTITY_ID: device, ATTR_HVAC_MODE: direction}
                if target is not None:
                    data[ATTR_TEMPERATURE] = target
                    await self.hass.services.async_call(CLIMATE_DOMAIN, SERVICE_SET_TEMPERATURE, data, blocking=True)
                else:
                    await self.hass.services.async_call(CLIMATE_DOMAIN, SERVICE_SET_HVAC_MODE, data, blocking=True)
        except HomeAssistantError as err:
            _LOGGER.error("Could not drive %s: %s", device, err)

    async def _async_switch(self, device: str, on: bool) -> None:
        try:
            await self.hass.services.async_call(
                "homeassistant", SERVICE_TURN_ON if on else SERVICE_TURN_OFF,
                {ATTR_ENTITY_ID: device}, blocking=True,
            )
        except HomeAssistantError as err:
            _LOGGER.error("Could not turn %s %s: %s", device, "on" if on else "off", err)
            return
        if on:
            self.state(device).last_sent_on = dt_util.utcnow()

    async def _async_off(self, device: str) -> None:
        if is_climate(device):
            await self._async_drive_climate(device, "", {}, None, None)
        else:
            await self._async_switch(device, False)

    # ------------------------------------------------- protection rules

    async def async_tick(self, device: str) -> None:
        """Periodic checks for a Shared device: max run time, running with nobody asking."""
        st = self.state(device)
        settings = st.settings
        state = self.hass.states.get(device)
        if settings is None or state is None:
            return
        now = dt_util.utcnow()
        running = self.is_running(device)

        if running and settings.max_run and st.running_since and now - st.running_since >= settings.max_run:
            st.resting_until = now + settings.rest
            st.owned = False
            await self._async_off(device)
            self._notification(
                device, "max_run",
                f"{settings.name} ran for {_fmt(settings.max_run)} without a break and was turned off. "
                f"It rests for {_fmt(settings.rest)}, then starts again if a room still needs it.",
            )
            return

        if running and not st.requests and settings.enforce_off:
            st.unexpected_on_since = st.unexpected_on_since or now
            if now - st.unexpected_on_since >= FAULT_GRACE:
                st.unexpected_on_since = None
                st.owned = False
                await self._async_off(device)
                self._notification(
                    device, "fault",
                    f"{settings.name} was running with no thermostat asking for it, so it was turned off.",
                )
                return
        else:
            st.unexpected_on_since = None

        await self.async_reconcile([device])

    def _notification(self, device: str, kind: str, message: str) -> None:
        settings = self.state(device).settings
        if settings and settings.notify:
            persistent_notification.async_create(
                self.hass, message, title=f"Slot Thermostat: {settings.name}",
                notification_id=f"{DOMAIN}_{kind}_{device}",
            )

    # ------------------------------------------------------- statistics

    def is_running(self, device: str) -> bool:
        state = self.hass.states.get(device)
        if state is None:
            return False
        return state.state not in NOT_RUNNING if is_climate(device) else state.state == STATE_ON

    def running_direction(self, device: str) -> Direction | None:
        """heat / cool while running (switches: the direction they're asked for)."""
        if not self.is_running(device):
            return None
        if is_climate(device):
            mode = self.hass.states.get(device).state
            return mode if mode in ("heat", "cool") else None
        st = self.state(device)
        if st.active:
            return st.active
        directions = {r.direction for r in st.requests.values()}
        return directions.pop() if len(directions) == 1 else st.running_direction or "heat"

    @callback
    def async_device_changed(self, device: str) -> None:
        """Track runs (called on the device's state changes)."""
        st = self.state(device)
        now = dt_util.utcnow()
        running = self.is_running(device)
        if running and st.running_since is None:
            st.running_since = now
            st.last_on = now
            st.running_direction = self.running_direction(device)
            st.started_by = sorted(r.name for r in st.requests.values())
        elif running:
            st.running_direction = self.running_direction(device) or st.running_direction
        elif st.running_since is not None:
            st.last_run = now - st.running_since
            st.last_direction = st.running_direction
            st.last_started_by = st.started_by
            st.last_off = now
            st.running_since = None
            st.running_direction = None
            st.started_by = []
        self._notify(device)

    def summary(self, device: str) -> dict[str, Any]:
        """Data for the status sensor and card."""
        st = self.state(device)
        active = [r.name for r in st.requests.values() if r.direction == st.active] if st.active else []
        waiting = [r.name for r in st.requests.values() if r.direction != st.active] if st.active else []
        return {
            "requested_by": sorted(active),
            "waiting": sorted(waiting),
            "running_since": st.running_since.isoformat() if st.running_since else None,
            "started_by": st.started_by,
            "last_run_seconds": int(st.last_run.total_seconds()) if st.last_run else None,
            "last_direction": st.last_direction,
            "last_started_by": st.last_started_by,
            "last_on": st.last_on.isoformat() if st.last_on else None,
            "last_off": st.last_off.isoformat() if st.last_off else None,
            "resting_until": st.resting_until.isoformat() if self.is_resting(device) else None,
        }

    def restore(self, device: str, attrs: dict[str, Any]) -> None:
        """Restore run statistics after a restart."""
        st = self.state(device)
        if (seconds := attrs.get("last_run_seconds")) is not None:
            st.last_run = timedelta(seconds=seconds)
        st.last_direction = attrs.get("last_direction")
        st.last_started_by = list(attrs.get("last_started_by") or [])
        st.last_on = dt_util.parse_datetime(attrs.get("last_on") or "")
        st.last_off = dt_util.parse_datetime(attrs.get("last_off") or "")

    @callback
    def async_listen(self, device: str, listener: Callable[[], None]) -> Callable[[], None]:
        listeners = self.state(device).listeners
        listeners.append(listener)
        return lambda: listeners.remove(listener)

    def _notify(self, device: str) -> None:
        for listener in list(self.state(device).listeners):
            listener()

    async def async_shutdown(self) -> None:
        """Fail-safe: what thermostats were running goes off when Home Assistant stops."""
        for device, st in list(self.devices.items()):
            if (st.owned or st.settings) and self.is_running(device):
                await self._async_off(device)


def _fmt(delta: timedelta) -> str:
    minutes = int(delta.total_seconds() // 60)
    hours, minutes = divmod(minutes, 60)
    if hours and minutes:
        return f"{hours} h {minutes} min"
    return f"{hours} h" if hours else f"{minutes} min"


def get_manager(hass: HomeAssistant) -> SharedDeviceManager:
    """The single manager instance."""
    data = hass.data.setdefault(DOMAIN, {"entities": {}})
    if "switches" not in data:
        data["switches"] = SharedDeviceManager(hass)
    return data["switches"]
