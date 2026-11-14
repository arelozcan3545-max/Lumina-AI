# ============================================================
# LUMINA AI - MAPS SERVICE
# ------------------------------------------------------------
# Decides which map renderer the browser should use:
#   * "google"       -> Google Maps JavaScript API (restricted browser key)
#   * "openstreetmap"-> Leaflet + OSM tiles (no key, honest fallback)
#
# The unrestricted server key is NEVER returned by this module.
# ============================================================

from __future__ import annotations

import os
from typing import Any, Dict

from location_service import google_maps_js_api_key, google_maps_api_key

OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıda bulunanlar'


def maps_status() -> Dict[str, Any]:
    browser_key = google_maps_js_api_key()
    server_key = google_maps_api_key()
    if browser_key:
        provider = "google"
        reason = None
    elif server_key:
        provider = "openstreetmap"
        reason = (
            "Google Maps tarayıcı anahtarı (GOOGLE_MAPS_JS_API_KEY) tanımlı değil. "
            "Harita OpenStreetMap ile gösteriliyor; işletme verileri Google Places'tan gelir."
        )
    else:
        provider = "openstreetmap"
        reason = (
            "Google Maps anahtarı tanımlı değil. Harita OpenStreetMap ile gösteriliyor; "
            "işletme aramaları için GOOGLE_MAPS_API_KEY gerekli."
        )
    return {
        "provider": provider,
        "available": True,  # OSM fallback always renders when online
        "attribution": OSM_ATTRIBUTION if provider == "openstreetmap" else "Google Maps",
        "tile_url": OSM_TILE_URL if provider == "openstreetmap" else None,
        "language": "tr",
        "region": "TR",
        "reason": reason,
        "browser_key_configured": bool(browser_key),
        "server_key_configured": bool(server_key),
    }


def public_map_config() -> Dict[str, Any]:
    """Authenticated-browser map configuration.

    `browser_key` is only included when GOOGLE_MAPS_JS_API_KEY is set. It must
    be restricted by HTTP referrer in Google Cloud. The server key is omitted.
    """
    status = maps_status()
    config = dict(status)
    if status["provider"] == "google":
        config["browser_key"] = google_maps_js_api_key()
        config["map_id"] = (os.getenv("GOOGLE_MAPS_MAP_ID") or "").strip() or None
    else:
        config["browser_key"] = None
        config["map_id"] = None
    config["security_note"] = (
        "Tarayıcı anahtarı Google Cloud'da yalnızca üretim HTTP referrer'larına ve "
        "Maps JavaScript API'sine kısıtlanmalıdır."
    )
    return config
