# ============================================================
# LUMINA AI - WEATHER SERVICE
# ------------------------------------------------------------
# Primary provider : Open-Meteo (commercial endpoint when a key is set)
# Fallback provider: OpenWeatherMap (optional key)
#
# Rules:
#   * Never fabricate weather data.
#   * Return source + fetched_at + cache metadata.
#   * Stale cache is explicitly marked and never presented as live.
# ============================================================

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone as dt_timezone
from typing import Any, Dict, List, Optional, Tuple

from location_service import (
    Coordinates,
    LocationServiceError,
    TTLCache,
    cache_ttl,
    open_meteo_api_key,
    openweather_api_key,
    request_json,
    utc_now_iso,
    validate_coordinates,
)

logger = logging.getLogger("LuminaWeather")

# WMO weather interpretation codes (Open-Meteo) -> Turkish label + icon.
WMO_CONDITIONS_TR: Dict[int, Tuple[str, str]] = {
    0: ("Açık", "☀️"),
    1: ("Az bulutlu", "🌤️"),
    2: ("Parçalı bulutlu", "⛅"),
    3: ("Kapalı", "☁️"),
    45: ("Sisli", "🌫️"),
    48: ("Kırağılı sis", "🌫️"),
    51: ("Hafif çisenti", "🌦️"),
    53: ("Orta çisenti", "🌦️"),
    55: ("Yoğun çisenti", "🌧️"),
    56: ("Hafif dondurucu çisenti", "🌧️"),
    57: ("Yoğun dondurucu çisenti", "🌧️"),
    61: ("Hafif yağmur", "🌦️"),
    63: ("Orta yağmur", "🌧️"),
    65: ("Şiddetli yağmur", "🌧️"),
    66: ("Hafif dondurucu yağmur", "🌧️"),
    67: ("Şiddetli dondurucu yağmur", "🌧️"),
    71: ("Hafif kar", "🌨️"),
    73: ("Orta kar", "🌨️"),
    75: ("Yoğun kar", "❄️"),
    77: ("Kar taneleri", "🌨️"),
    80: ("Hafif sağanak", "🌦️"),
    81: ("Orta sağanak", "🌧️"),
    82: ("Şiddetli sağanak", "⛈️"),
    85: ("Hafif kar sağanağı", "🌨️"),
    86: ("Yoğun kar sağanağı", "❄️"),
    95: ("Gök gürültülü fırtına", "⛈️"),
    96: ("Dolulu fırtına", "⛈️"),
    97: ("Şiddetli fırtına", "⛈️"),
    99: ("Dolulu şiddetli fırtına", "⛈️"),
}


def weather_code_info(code: Any) -> Dict[str, Any]:
    try:
        numeric = int(code)
    except (TypeError, ValueError):
        numeric = -1
    label, icon = WMO_CONDITIONS_TR.get(numeric, ("Bilinmeyen hava durumu", "❔"))
    return {"code": numeric, "condition": label, "icon": icon}


# OpenWeatherMap condition id -> WMO-like code (best effort, clearly sourced).
_OWM_TO_WMO = {
    200: 95, 201: 95, 202: 95, 210: 95, 211: 95, 212: 95, 221: 95,
    230: 95, 231: 95, 232: 95,
    300: 51, 301: 53, 302: 55, 310: 51, 311: 53, 312: 55, 313: 55, 314: 55,
    321: 55,
    500: 61, 501: 63, 502: 65, 503: 65, 504: 65, 511: 66, 520: 80, 521: 81,
    522: 82, 531: 82,
    600: 71, 601: 73, 602: 75, 611: 66, 612: 66, 613: 67, 615: 71, 616: 73,
    620: 85, 621: 86, 622: 86,
    701: 45, 711: 45, 721: 45, 731: 45, 741: 45, 751: 45, 761: 45, 762: 45,
    771: 95, 781: 95,
    800: 0, 801: 1, 802: 2, 803: 3, 804: 3,
}


def _safe_float(value: Any, digits: int = 1) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, digits)


def _day_label(date_text: str) -> str:
    weekdays = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"]
    try:
        day = datetime.strptime(date_text, "%Y-%m-%d")
    except (TypeError, ValueError):
        return ""
    return weekdays[day.weekday()]


def _short_time(value: Any) -> Optional[str]:
    text = str(value or "")
    if "T" in text and len(text) >= 16:
        return text.split("T", 1)[1][:5]
    if len(text) == 5 and ":" in text:
        return text
    return None


def _owm_local_time(value: Any, offset_seconds: int) -> Optional[str]:
    """Converts OpenWeatherMap's UTC `dt_txt` into the location's local time."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        utc_dt = datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    local_dt = utc_dt + timedelta(seconds=int(offset_seconds or 0))
    return local_dt.strftime("%Y-%m-%dT%H:%M")


def _local_now(utc_offset_seconds: int) -> datetime:
    return datetime.now(dt_timezone.utc) + timedelta(seconds=int(utc_offset_seconds or 0))


def _select_next_hours(hourly: Dict[str, Any], current_time: str, count: int = 24) -> List[Dict[str, Any]]:
    times = list(hourly.get("time") or [])
    if not times:
        return []
    start_index = 0
    for idx, stamp in enumerate(times):
        if str(stamp) >= str(current_time or ""):
            start_index = idx
            break
    items: List[Dict[str, Any]] = []
    for idx in range(start_index, min(len(times), start_index + count)):
        code_info = weather_code_info(_list_get(hourly, "weather_code", idx))
        items.append(
            {
                "time": str(times[idx])[:32],
                "temperature": _safe_float(_list_get(hourly, "temperature_2m", idx)),
                "apparent_temperature": _safe_float(_list_get(hourly, "apparent_temperature", idx)),
                "precipitation_probability": _safe_float(_list_get(hourly, "precipitation_probability", idx), 0),
                "precipitation": _safe_float(_list_get(hourly, "precipitation", idx), 2),
                "wind_speed": _safe_float(_list_get(hourly, "wind_speed_10m", idx)),
                "humidity": _safe_float(_list_get(hourly, "relative_humidity_2m", idx), 0),
                "condition": code_info["condition"],
                "icon": code_info["icon"],
            }
        )
    return items


def _list_get(payload: Dict[str, Any], key: str, idx: int) -> Any:
    values = payload.get(key) or []
    try:
        return values[idx]
    except (IndexError, TypeError):
        return None


_weather_cache = TTLCache(
    cache_ttl("weather", 600),
    max_entries=256,
    stale_seconds=max(3600, cache_ttl("weather_stale", 6 * 3600)),
)


def forecast(
    coords: Coordinates,
    *,
    label: Optional[str] = None,
    days: int = 7,
    timezone_hint: Optional[str] = None,
) -> Dict[str, Any]:
    """Returns normalized weather. Raises if no provider and no stale cache."""
    safe = coords.rounded(3)  # ~110 m; weather models do not need finer.
    days = max(1, min(7, int(days or 7)))
    cache_key = f"weather:{safe.latitude}:{safe.longitude}:{days}:{(timezone_hint or 'auto')[:64]}"
    cached = _weather_cache.get(cache_key)
    if cached:
        value, age, fresh = cached
        result = dict(value)
        result["cached"] = True
        result["cache_age_seconds"] = age
        if not fresh:
            result["stale"] = True
            result["live"] = False
            result["warning"] = (
                f"Canlı hava verisi şu anda alınamadı. {max(1, age // 60)} dakika önceki önbellek gösteriliyor; "
                "bu veri güncel değildir."
            )
        return result

    errors: List[str] = []
    open_meteo_key = open_meteo_api_key()
    try:
        result = _fetch_open_meteo(safe, label=label, days=days, api_key=open_meteo_key, timezone_hint=timezone_hint)
        _weather_cache.set(cache_key, result)
        return result
    except LocationServiceError as exc:
        errors.append(exc.public_message)
        logger.info("Open-Meteo saglayicisi basarisiz: %s", exc.code)

    if openweather_api_key():
        try:
            result = _fetch_openweather(safe, label=label, days=days, timezone_hint=timezone_hint)
            result["fallback_from"] = "Open-Meteo"
            result["warning"] = "Open-Meteo'ya ulaşılamadı; yedek sağlayıcı OpenWeatherMap kullanıldı."
            _weather_cache.set(cache_key, result)
            return result
        except LocationServiceError as exc:
            errors.append(exc.public_message)
            logger.info("OpenWeatherMap saglayicisi basarisiz: %s", exc.code)

    # Last resort: an explicitly stale cache entry was already returned above.
    raise LocationServiceError(
        "Hava durumu sağlayıcısına ulaşılamadı. Canlı veri olmadan tahmin üretilmeyecek.",
        provider="weather",
        code="weather_unavailable",
    )


def _fetch_open_meteo(
    coords: Coordinates,
    *,
    label: Optional[str],
    days: int,
    api_key: str,
    timezone_hint: Optional[str],
) -> Dict[str, Any]:
    base = "https://customer-api.open-meteo.com/v1/forecast" if api_key else "https://api.open-meteo.com/v1/forecast"
    params: Dict[str, Any] = {
        "latitude": coords.latitude,
        "longitude": coords.longitude,
        "current": ",".join(
            [
                "temperature_2m",
                "relative_humidity_2m",
                "apparent_temperature",
                "is_day",
                "precipitation",
                "weather_code",
                "wind_speed_10m",
                "wind_gusts_10m",
                "wind_direction_10m",
            ]
        ),
        "hourly": ",".join(
            [
                "temperature_2m",
                "apparent_temperature",
                "precipitation_probability",
                "precipitation",
                "weather_code",
                "wind_speed_10m",
                "relative_humidity_2m",
            ]
        ),
        "daily": ",".join(
            [
                "weather_code",
                "temperature_2m_max",
                "temperature_2m_min",
                "apparent_temperature_max",
                "apparent_temperature_min",
                "precipitation_sum",
                "precipitation_probability_max",
                "wind_speed_10m_max",
                "sunrise",
                "sunset",
                "uv_index_max",
            ]
        ),
        "timezone": timezone_hint or "auto",
        "forecast_days": days,
        "temperature_unit": "celsius",
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm",
        "timeformat": "iso8601",
    }
    if api_key:
        params["apikey"] = api_key

    payload = request_json("GET", base, provider="open_meteo", params=params)
    tz = str(payload.get("timezone") or timezone_hint or "UTC")[:80]
    offset = int(payload.get("utc_offset_seconds") or 0)
    current_raw = payload.get("current") or {}
    daily_raw = payload.get("daily") or {}
    hourly_raw = payload.get("hourly") or {}
    current_info = weather_code_info(current_raw.get("weather_code"))
    local_now = _local_now(offset)
    current_time = str(current_raw.get("time") or local_now.strftime("%Y-%m-%dT%H:%M"))[:32]

    daily: List[Dict[str, Any]] = []
    dates = list(daily_raw.get("time") or [])
    for idx, date_text in enumerate(dates[:days]):
        code_info = weather_code_info(_list_get(daily_raw, "weather_code", idx))
        daily.append(
            {
                "date": str(date_text)[:10],
                "weekday": _day_label(str(date_text)),
                "condition": code_info["condition"],
                "icon": code_info["icon"],
                "temp_max": _safe_float(_list_get(daily_raw, "temperature_2m_max", idx)),
                "temp_min": _safe_float(_list_get(daily_raw, "temperature_2m_min", idx)),
                "apparent_max": _safe_float(_list_get(daily_raw, "apparent_temperature_max", idx)),
                "apparent_min": _safe_float(_list_get(daily_raw, "apparent_temperature_min", idx)),
                "precipitation_sum": _safe_float(_list_get(daily_raw, "precipitation_sum", idx), 2),
                "precipitation_probability": _safe_float(
                    _list_get(daily_raw, "precipitation_probability_max", idx), 0
                ),
                "wind_speed_max": _safe_float(_list_get(daily_raw, "wind_speed_10m_max", idx)),
                "sunrise": _short_time(_list_get(daily_raw, "sunrise", idx)),
                "sunset": _short_time(_list_get(daily_raw, "sunset", idx)),
                "uv_index": _safe_float(_list_get(daily_raw, "uv_index_max", idx), 1),
            }
        )

    return {
        "success": True,
        "location_label": (label or "Seçilen konum")[:160],
        "timezone": tz,
        "utc_offset_seconds": offset,
        "current": {
            "time": current_time,
            "temperature": _safe_float(current_raw.get("temperature_2m")),
            "apparent_temperature": _safe_float(current_raw.get("apparent_temperature")),
            "humidity": _safe_float(current_raw.get("relative_humidity_2m"), 0),
            "precipitation": _safe_float(current_raw.get("precipitation"), 2),
            "precipitation_probability": _safe_float(
                _list_get(hourly_raw, "precipitation_probability", 0), 0
            ),
            "wind_speed": _safe_float(current_raw.get("wind_speed_10m")),
            "wind_gusts": _safe_float(current_raw.get("wind_gusts_10m")),
            "wind_direction": _safe_float(current_raw.get("wind_direction_10m"), 0),
            "condition": current_info["condition"],
            "icon": current_info["icon"],
            "is_day": bool(current_raw.get("is_day")) if current_raw.get("is_day") is not None else None,
        },
        "hourly": _select_next_hours(hourly_raw, current_time, 48),
        "daily": daily,
        "source": "Open-Meteo" if not api_key else "Open-Meteo (ticari API)",
        "source_license": "CC BY 4.0",
        "fetched_at": utc_now_iso(),
        "cached": False,
        "cache_age_seconds": 0,
        "stale": False,
        "live": True,
        "warning": None,
    }


def _fetch_openweather(
    coords: Coordinates,
    *,
    label: Optional[str],
    days: int,
    timezone_hint: Optional[str],
) -> Dict[str, Any]:
    key = openweather_api_key()
    if not key:
        raise LocationServiceError("OpenWeatherMap anahtarı tanımlı değil.", provider="openweather")

    current_payload = request_json(
        "GET",
        "https://api.openweathermap.org/data/2.5/weather",
        provider="openweather",
        params={
            "lat": coords.latitude,
            "lon": coords.longitude,
            "appid": key,
            "units": "metric",
            "lang": "tr",
        },
    )
    forecast_payload = request_json(
        "GET",
        "https://api.openweathermap.org/data/2.5/forecast",
        provider="openweather",
        params={
            "lat": coords.latitude,
            "lon": coords.longitude,
            "appid": key,
            "units": "metric",
            "lang": "tr",
        },
    )

    offset = int(((current_payload.get("city") or {}).get("timezone")) or 0)
    local_now = _local_now(offset)
    main = current_payload.get("main") or {}
    wind = current_payload.get("wind") or {}
    weather_items = current_payload.get("weather") or [{}]
    code = _OWM_TO_WMO.get(int(weather_items[0].get("id") or 800), -1)
    info = weather_code_info(code)
    current_time = local_now.strftime("%Y-%m-%dT%H:%M")

    entries = list(forecast_payload.get("list") or [])
    hourly: List[Dict[str, Any]] = []
    for entry in entries[:8]:
        item_info = weather_code_info(_OWM_TO_WMO.get(int((entry.get("weather") or [{}])[0].get("id") or 800), -1))
        entry_main = entry.get("main") or {}
        hourly.append(
            {
                "time": _owm_local_time(entry.get("dt_txt"), offset) or "",
                "temperature": _safe_float(entry_main.get("temp")),
                "apparent_temperature": _safe_float(entry_main.get("feels_like")),
                "precipitation_probability": _safe_float(entry.get("pop", 0) * 100, 0),
                "precipitation": _safe_float((entry.get("rain") or {}).get("3h"), 2),
                "wind_speed": _safe_float((entry.get("wind") or {}).get("speed", 0) * 3.6),
                "humidity": _safe_float(entry_main.get("humidity"), 0),
                "condition": item_info["condition"],
                "icon": item_info["icon"],
            }
        )

    daily_map: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        # Bucket by the location's local date, not the provider's UTC date.
        date_text = (_owm_local_time(entry.get("dt_txt"), offset) or "")[:10]
        if not date_text:
            continue
        item_info = weather_code_info(_OWM_TO_WMO.get(int((entry.get("weather") or [{}])[0].get("id") or 800), -1))
        entry_main = entry.get("main") or {}
        bucket = daily_map.setdefault(
            date_text,
            {
                "date": date_text,
                "weekday": _day_label(date_text),
                "condition": item_info["condition"],
                "icon": item_info["icon"],
                "temp_max": None,
                "temp_min": None,
                "apparent_max": None,
                "apparent_min": None,
                "precipitation_sum": 0.0,
                "precipitation_probability": 0,
                "wind_speed_max": 0.0,
                "sunrise": None,
                "sunset": None,
                "uv_index": None,
            },
        )
        temp_max = _safe_float(entry_main.get("temp_max"))
        temp_min = _safe_float(entry_main.get("temp_min"))
        if temp_max is not None:
            bucket["temp_max"] = max(bucket["temp_max"] or temp_max, temp_max)
        if temp_min is not None:
            bucket["temp_min"] = min(bucket["temp_min"] or temp_min, temp_min)
        bucket["precipitation_sum"] = round(
            float(bucket["precipitation_sum"] or 0) + float((entry.get("rain") or {}).get("3h") or 0), 2
        )
        bucket["precipitation_probability"] = max(
            int(bucket["precipitation_probability"] or 0), int(round(float(entry.get("pop") or 0) * 100))
        )
        bucket["wind_speed_max"] = max(
            float(bucket["wind_speed_max"] or 0), float((entry.get("wind") or {}).get("speed") or 0) * 3.6
        )

    daily = sorted(daily_map.values(), key=lambda d: d["date"])[:days]
    for day in daily:
        day["wind_speed_max"] = round(float(day.get("wind_speed_max") or 0), 1)

    return {
        "success": True,
        "location_label": (label or "Seçilen konum")[:160],
        "timezone": (timezone_hint or f"UTC{offset // 3600:+d}")[:80],
        "utc_offset_seconds": offset,
        "current": {
            "time": current_time,
            "temperature": _safe_float(main.get("temp")),
            "apparent_temperature": _safe_float(main.get("feels_like")),
            "humidity": _safe_float(main.get("humidity"), 0),
            "precipitation": _safe_float((current_payload.get("rain") or {}).get("1h"), 2),
            "precipitation_probability": hourly[0]["precipitation_probability"] if hourly else None,
            "wind_speed": _safe_float(wind.get("speed", 0) * 3.6),
            "wind_gusts": _safe_float(wind.get("gust", 0) * 3.6) if wind.get("gust") else None,
            "wind_direction": _safe_float(wind.get("deg"), 0),
            "condition": info["condition"],
            "icon": info["icon"],
            "is_day": None,
        },
        "hourly": hourly,
        "daily": daily,
        "source": "OpenWeatherMap",
        "source_license": "OpenWeatherMap kullanım koşulları",
        "fetched_at": utc_now_iso(),
        "cached": False,
        "cache_age_seconds": 0,
        "stale": False,
        "live": True,
        "warning": "OpenWeatherMap ücretsiz planı 5 günlük tahmin sağlar.",
    }


def select_target_day(weather: Dict[str, Any], scope: str) -> Optional[Dict[str, Any]]:
    """Selects today/tomorrow/day-after in the location's local timezone."""
    offset = int(weather.get("utc_offset_seconds") or 0)
    base = _local_now(offset).date()
    delta = {"today": 0, "tomorrow": 1, "day_after": 2, "week": 0}.get((scope or "today").lower(), 0)
    target = (base + timedelta(days=delta)).isoformat()
    for day in weather.get("daily") or []:
        if day.get("date") == target:
            return day
    return None


def weather_status() -> Dict[str, Any]:
    return {
        "open_meteo_configured": True,  # free tier works without a key
        "open_meteo_commercial_key": bool(open_meteo_api_key()),
        "openweather_fallback": bool(openweather_api_key()),
        "cache_entries": len(_weather_cache),
    }
