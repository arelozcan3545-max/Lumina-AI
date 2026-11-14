# ============================================================
# LUMINA AI - ROUTES SERVICE (GOOGLE ROUTES API)
# ------------------------------------------------------------
# Compute Routes (v2) wrapper with validation, caching and
# Turkish-safe error messages. Requires GOOGLE_MAPS_API_KEY.
# ============================================================

from __future__ import annotations

from typing import Any, Dict, List, Optional

from location_service import (
    Coordinates,
    LocationConfigurationError,
    LocationValidationError,
    TTLCache,
    cache_ttl,
    google_maps_api_key,
    haversine_km,
    request_json,
    utc_now_iso,
    validate_coordinates,
)

TRAVEL_MODES = {"DRIVE", "WALK", "BICYCLE", "TRANSIT"}
TRAVEL_MODE_LABELS_TR = {
    "DRIVE": "Araba",
    "WALK": "Yürüyüş",
    "BICYCLE": "Bisiklet",
    "TRANSIT": "Toplu taşıma",
}
GOOGLE_TRAVEL_MODE = {
    "DRIVE": "driving",
    "WALK": "walking",
    "BICYCLE": "bicycling",
    "TRANSIT": "transit",
}

_ROUTE_FIELD_MASK = ",".join(
    [
        "routes.distanceMeters",
        "routes.duration",
        "routes.polyline.encodedPolyline",
        "routes.legs.steps.navigationInstruction",
        "routes.legs.steps.distanceMeters",
        "routes.legs.steps.staticDuration",
        "routes.legs.steps.travelMode",
        "routes.legs.localizedValues",
    ]
)

_routes_cache = TTLCache(cache_ttl("routes", 120), max_entries=128)


def _parse_duration_seconds(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return max(0, int(value))
    text = str(value).strip()
    if text.endswith("s") and text[:-1].replace(".", "", 1).isdigit():
        return max(0, int(float(text[:-1])))
    return None


def compute_route(
    origin: Coordinates,
    destination: Coordinates,
    *,
    travel_mode: str = "DRIVE",
    language: str = "tr-TR",
    destination_label: Optional[str] = None,
    origin_label: Optional[str] = None,
) -> Dict[str, Any]:
    key = google_maps_api_key()
    if not key:
        raise LocationConfigurationError(
            "Yol tarifi için sunucuda GOOGLE_MAPS_API_KEY tanımlı olmalı ve Routes API etkinleştirilmelidir.",
            provider="google_routes",
        )

    mode = (travel_mode or "DRIVE").upper().strip()
    if mode not in TRAVEL_MODES:
        raise LocationValidationError("Desteklenmeyen ulaşım modu.")

    # ~11 m precision is sufficient for routing and limits data exposure.
    start = origin.rounded(4)
    end = destination.rounded(4)
    direct_km = haversine_km(start, end)
    if direct_km > 500:
        raise LocationValidationError("Yol tarifi mesafesi çok uzun (500 km üzeri). Lütfen daha yakın bir hedef seç.")

    cache_key = f"route:{mode}:{start.latitude}:{start.longitude}:{end.latitude}:{end.longitude}:{language}"
    cached = _routes_cache.get(cache_key)
    if cached:
        value = dict(cached[0])
        value["cached"] = True
        value["cache_age_seconds"] = cached[1]
        return value

    body: Dict[str, Any] = {
        "origin": {"location": {"latLng": {"latitude": start.latitude, "longitude": start.longitude}}},
        "destination": {"location": {"latLng": {"latitude": end.latitude, "longitude": end.longitude}}},
        "travelMode": mode,
        "computeAlternativeRoutes": False,
        "languageCode": language,
        "units": "METRIC",
    }
    if mode == "DRIVE":
        body["routingPreference"] = "TRAFFIC_AWARE"
        body["routeModifiers"] = {"avoidTolls": False, "avoidHighways": False, "avoidFerries": False}

    payload = request_json(
        "POST",
        "https://routes.googleapis.com/directions/v2:computeRoutes",
        provider="google_routes",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": _ROUTE_FIELD_MASK,
        },
        json=body,
    )

    routes = list(payload.get("routes") or [])
    if not routes:
        raise LocationValidationError("Bu iki nokta arasında yol tarifi bulunamadı.")
    route = routes[0]
    distance_m = route.get("distanceMeters")
    duration_s = _parse_duration_seconds(route.get("duration"))
    steps: List[Dict[str, Any]] = []
    for leg in route.get("legs") or []:
        for step in leg.get("steps") or []:
            instruction = ((step.get("navigationInstruction") or {}).get("instructions") or "").strip()
            if not instruction:
                continue
            steps.append(
                {
                    "instruction": instruction[:240],
                    "distance_m": step.get("distanceMeters"),
                    "duration_seconds": _parse_duration_seconds(step.get("staticDuration")),
                    "travel_mode": str(step.get("travelMode") or mode)[:20],
                }
            )
            if len(steps) >= 30:
                break
        if len(steps) >= 30:
            break

    polyline = ((route.get("polyline") or {}).get("encodedPolyline") or "")[:6000] or None
    try:
        distance_km = round(float(distance_m) / 1000.0, 2) if distance_m is not None else None
    except (TypeError, ValueError):
        distance_km = None
    duration_min = round(duration_s / 60.0, 1) if duration_s is not None else None

    result = {
        "success": True,
        "origin": start.as_dict(4),
        "destination": end.as_dict(4),
        "origin_label": (origin_label or "Başlangıç")[:160],
        "destination_label": (destination_label or "Hedef")[:160],
        "travel_mode": mode,
        "travel_mode_label": TRAVEL_MODE_LABELS_TR[mode],
        "distance_km": distance_km,
        "duration_minutes": duration_min,
        "duration_seconds": duration_s,
        "direct_distance_km": round(direct_km, 2),
        "steps": steps,
        "polyline": polyline,
        "google_maps_url": (
            "https://www.google.com/maps/dir/?api=1"
            f"&origin={start.latitude},{start.longitude}"
            f"&destination={end.latitude},{end.longitude}"
            f"&travelmode={GOOGLE_TRAVEL_MODE[mode]}"
        ),
        "source": "Google Routes API - Compute Routes",
        "fetched_at": utc_now_iso(),
        "cached": False,
        "cache_age_seconds": 0,
    }
    _routes_cache.set(cache_key, result)
    return result


def routes_status() -> Dict[str, Any]:
    return {
        "configured": bool(google_maps_api_key()),
        "provider": "Google Routes API",
        "travel_modes": sorted(TRAVEL_MODES),
        "cache_entries": len(_routes_cache),
    }
