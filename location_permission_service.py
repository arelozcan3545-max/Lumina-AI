# ============================================================
# LUMINA AI - LOCATION PERMISSION SERVICE
# ------------------------------------------------------------
# Owns the user's explicit location consent and the minimum
# persisted state needed to honour it.
#
# PRIVACY RULES
#   * A device fix is only used for the current request. It is
#     NEVER written to storage or logs.
#   * What persists is: consent state, an optional manual city
#     label and a city-level coordinate (2 decimals, ~1.1 km).
#   * A denied permission is remembered so the UI does not ask
#     again; the user can still pick a city manually.
# ============================================================

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from location_service import (
    Coordinates,
    LocationValidationError,
    sanitize_place_query,
    validate_coordinates,
)

# unset   -> never asked
# granted -> the user allowed a device fix for this session
# denied  -> the user refused; do not ask again
# manual  -> the user chose a city instead of the device
STATE_UNSET = "unset"
STATE_GRANTED = "granted"
STATE_DENIED = "denied"
STATE_MANUAL = "manual"
STATE_OFF = "off"

VALID_STATES = {STATE_UNSET, STATE_GRANTED, STATE_DENIED, STATE_MANUAL, STATE_OFF}

# A city-level coordinate is enough to select a weather grid and a
# reasonable search centre. Device precision is intentionally dropped.
CITY_COORDINATE_DECIMALS = 2

PREFERENCE_KEY = "location_preference"

MAX_CITY_LABEL_LEN = 120


def _clean_label(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = " ".join(value.replace("\x00", " ").split())
    return cleaned[:MAX_CITY_LABEL_LEN]


def default_preference() -> Dict[str, Any]:
    return {
        "permission": STATE_UNSET,
        "manual_city": None,
        "manual_latitude": None,
        "manual_longitude": None,
        "updated_at": None,
        "note": "Konum izni henüz sorulmadı.",
    }


def normalize_preference(raw: Any) -> Dict[str, Any]:
    """Returns a safe preference dict, discarding anything unexpected.

    Only the documented, low-precision fields are kept. Any device-grade
    coordinate that might have been stored by an older build is dropped.
    """
    pref = default_preference()
    if not isinstance(raw, dict):
        return pref

    state = str(raw.get("permission") or "").strip().lower()
    if state in VALID_STATES:
        pref["permission"] = state

    city = _clean_label(raw.get("manual_city"))
    pref["manual_city"] = city or None

    lat = raw.get("manual_latitude")
    lng = raw.get("manual_longitude")
    if city and lat is not None and lng is not None:
        try:
            coords = validate_coordinates(lat, lng, decimals=CITY_COORDINATE_DECIMALS)
        except LocationValidationError:
            coords = None
        if coords is not None:
            pref["manual_latitude"] = coords.latitude
            pref["manual_longitude"] = coords.longitude
        else:
            pref["manual_city"] = None

    updated = raw.get("updated_at")
    if isinstance(updated, (int, float)):
        pref["updated_at"] = int(updated)

    pref["note"] = preference_note(pref)
    return pref


def preference_note(pref: Dict[str, Any]) -> str:
    state = pref.get("permission")
    if state == STATE_GRANTED:
        return "Bu oturum için cihaz konumu izni verildi."
    if state == STATE_DENIED:
        return "Konum izni reddedildi. Tekrar sorulmayacak; şehir seçerek devam edebilirsin."
    if state == STATE_MANUAL:
        return "Manuel şehir kullanılıyor; cihaz konumu istenmedi."
    if state == STATE_OFF:
        return "Konum özelliği kapatıldı."
    return "Konum izni henüz sorulmadı."


def get_preference(profile: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(profile, dict):
        return default_preference()
    return normalize_preference(profile.get(PREFERENCE_KEY))


def set_preference(
    profile: Dict[str, Any],
    *,
    permission: Optional[str] = None,
    manual_city: Optional[str] = None,
    manual_latitude: Optional[float] = None,
    manual_longitude: Optional[float] = None,
    updated_at: Optional[int] = None,
    clear_manual: bool = False,
) -> Dict[str, Any]:
    """Mutates `profile` in place and returns the normalized preference.

    Callers persist the profile through the existing atomic store.
    """
    if not isinstance(profile, dict):
        raise LocationValidationError("Profil bilgisi geçersiz.")

    current = get_preference(profile)
    if permission is not None:
        state = str(permission).strip().lower()
        if state not in VALID_STATES:
            raise LocationValidationError("Geçersiz konum izni durumu.")
        current["permission"] = state

    if clear_manual:
        current["manual_city"] = None
        current["manual_latitude"] = None
        current["manual_longitude"] = None
    elif manual_city is not None:
        label = _clean_label(manual_city)
        if label:
            label = sanitize_place_query(label)[:MAX_CITY_LABEL_LEN]
        if not label:
            current["manual_city"] = None
            current["manual_latitude"] = None
            current["manual_longitude"] = None
        else:
            if manual_latitude is None or manual_longitude is None:
                raise LocationValidationError("Manuel şehir için koordinat gerekli.")
            coords = validate_coordinates(
                manual_latitude, manual_longitude, decimals=CITY_COORDINATE_DECIMALS
            )
            current["manual_city"] = label
            current["manual_latitude"] = coords.latitude
            current["manual_longitude"] = coords.longitude

    if updated_at is not None:
        current["updated_at"] = int(updated_at)

    current["note"] = preference_note(current)
    profile[PREFERENCE_KEY] = current
    return current


def preference_coordinates(pref: Dict[str, Any]) -> Optional[Coordinates]:
    lat = pref.get("manual_latitude")
    lng = pref.get("manual_longitude")
    if lat is None or lng is None:
        return None
    try:
        return validate_coordinates(lat, lng, decimals=CITY_COORDINATE_DECIMALS)
    except LocationValidationError:
        return None


def resolve_request_origin(
    req_location: Any,
    pref: Dict[str, Any],
) -> Dict[str, Any]:
    """Decides which origin a chat request may use.

    Returns a dict with `coords`, `label`, `source` and a Turkish
    explanation. Device coordinates require explicit consent
    (`location.consent == true`). A denied permission never falls back
    to the device: only a manual city can be used.
    """
    state = pref.get("permission") or STATE_UNSET
    manual_coords = preference_coordinates(pref)
    manual_label = pref.get("manual_city")
    device_allowed = state not in {STATE_DENIED, STATE_OFF}

    if isinstance(req_location, dict) and device_allowed:
        consent = bool(req_location.get("consent"))
        coords_payload = req_location.get("coordinates") or {}
        label = _clean_label(req_location.get("label"))
        if consent:
            try:
                device = validate_coordinates(
                    coords_payload.get("latitude"),
                    coords_payload.get("longitude"),
                    decimals=4,
                )
                # Device fixes are used once and never stored.
                return {
                    "coords": device,
                    "label": label or "Mevcut konumun",
                    "source": "device",
                    "precision_decimals": 4,
                    "explanation": "Konum, cihazından açık izinle alındı ve yalnızca bu istek için kullanıldı.",
                }
            except LocationValidationError as exc:
                if not manual_coords:
                    return {
                        "coords": None,
                        "label": manual_label,
                        "source": "error",
                        "precision_decimals": 0,
                        "explanation": exc.public_message,
                    }

    if manual_coords and manual_label:
        return {
            "coords": manual_coords,
            "label": manual_label,
            "source": "manual_city",
            "precision_decimals": CITY_COORDINATE_DECIMALS,
            "explanation": "Manuel olarak seçtiğin şehir kullanılıyor; cihaz konumu istenmedi.",
        }

    if state == STATE_DENIED:
        return {
            "coords": None,
            "label": None,
            "source": "denied",
            "precision_decimals": 0,
            "explanation": (
                "Konum izni reddedildi. Cihaz konumu tekrar istenmeyecek. "
                "Şehir seçerek hava durumu veya yakın mekân araması yapabilirsin."
            ),
        }

    return {
        "coords": None,
        "label": None,
        "source": "none",
        "precision_decimals": 0,
        "explanation": (
            "Konum yok. Bir şehir seçebilir veya izin vererek mevcut konumunu kullanabilirsin."
        ),
    }


def public_preference(pref: Dict[str, Any]) -> Dict[str, Any]:
    """Browser-safe preference payload (2-decimal city coordinates only)."""
    return {
        "permission": pref.get("permission") or STATE_UNSET,
        "manual_city": pref.get("manual_city"),
        "manual_coordinates": (
            {
                "latitude": pref.get("manual_latitude"),
                "longitude": pref.get("manual_longitude"),
            }
            if pref.get("manual_latitude") is not None
            else None
        ),
        "updated_at": pref.get("updated_at"),
        "note": pref.get("note") or preference_note(pref),
        "can_ask_again": (pref.get("permission") or STATE_UNSET) not in {STATE_DENIED, STATE_OFF},
    }


def save_preference_for_profile(
    profile: Dict[str, Any],
    *,
    persist: Optional[Callable[[Dict[str, Any]], Any]] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    """Updates the preference and optionally persists the whole profile."""
    pref = set_preference(profile, **kwargs)
    if callable(persist):
        persist(profile)
    return pref
