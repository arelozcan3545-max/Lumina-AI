# ============================================================
# LUMINA AI - LOCATION SERVICE (CORE GEOSPATIAL PRIMITIVES)
# ------------------------------------------------------------
# This module owns the shared, provider-agnostic location layer:
#   * coordinate validation and privacy-aware rounding
#   * distance calculation
#   * TTL caching (fresh + stale window)
#   * per-user and per-provider quotas
#   * timeouts, error classification and a small circuit breaker
#   * geocoding (Google Geocoding -> Open-Meteo fallback)
#
# SECURITY NOTES
#   - API keys are read from environment variables only.
#   - Raw coordinates are never written to logs or error messages.
#   - Provider URLs are never logged (they can contain keys/coordinates).
#   - Cache keys use rounded coordinates (minimum useful precision).
# ============================================================

from __future__ import annotations

import math
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone as dt_timezone
from typing import Any, Dict, List, Optional, Tuple

import requests

# Reuse the application logger; it must never receive coordinates.
import logging

logger = logging.getLogger("LuminaLocation")

# ------------------------------------------------------------
# Environment helpers (lazy: .env is loaded by main after imports)
# ------------------------------------------------------------

def _env_str(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except (TypeError, ValueError):
        return default


def google_maps_api_key() -> str:
    """Server-side key for Places / Geocoding / Routes."""
    return _env_str("GOOGLE_MAPS_API_KEY") or _env_str("GOOGLE_PLACES_API_KEY")


def google_maps_js_api_key() -> str:
    """Restricted browser key for the Maps JavaScript API.

    This key is intentionally delivered to authenticated browsers by the
    backend. It MUST be restricted in Google Cloud to the production HTTP
    referrers and to the Maps JavaScript API only. The unrestricted server
    key is never sent to the browser.
    """
    return _env_str("GOOGLE_MAPS_JS_API_KEY")


def open_meteo_api_key() -> str:
    return _env_str("OPEN_METEO_API_KEY")


def openweather_api_key() -> str:
    return _env_str("OPENWEATHER_API_KEY")


def location_feature_enabled() -> bool:
    return _env_str("LUMINA_ENABLE_LOCATION", "1") not in {"0", "false", "False", "no", "NO"}


def http_timeout() -> float:
    return max(2.0, min(20.0, _env_float("LUMINA_LOCATION_HTTP_TIMEOUT", 7.0)))


def cache_ttl(provider: str, default: int) -> int:
    return max(30, _env_int(f"LUMINA_{provider.upper()}_CACHE_TTL", default))


def utc_now_iso() -> str:
    return datetime.now(dt_timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ------------------------------------------------------------
# Errors
# ------------------------------------------------------------

class LocationServiceError(Exception):
    """Base error. Public messages are Turkish and never contain coordinates."""

    code = "location_error"
    status_code = 502
    retryable = True

    def __init__(
        self,
        message: str,
        *,
        provider: Optional[str] = None,
        status_code: Optional[int] = None,
        retryable: Optional[bool] = None,
        code: Optional[str] = None,
    ):
        super().__init__(message)
        self.public_message = message
        self.provider = provider
        if status_code is not None:
            self.status_code = status_code
        if retryable is not None:
            self.retryable = retryable
        if code is not None:
            self.code = code

    def to_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "message": self.public_message,
            "provider": self.provider,
            "retryable": self.retryable,
        }


class LocationConfigurationError(LocationServiceError):
    code = "provider_not_configured"
    status_code = 503
    retryable = False


class LocationValidationError(LocationServiceError):
    code = "invalid_location"
    status_code = 400
    retryable = False


class LocationNotFoundError(LocationServiceError):
    code = "location_not_found"
    status_code = 404
    retryable = False


class LocationTimeoutError(LocationServiceError):
    code = "provider_timeout"
    status_code = 504
    retryable = True


class LocationUpstreamError(LocationServiceError):
    code = "provider_error"
    status_code = 502
    retryable = True


class LocationRateLimitError(LocationServiceError):
    code = "user_rate_limited"
    status_code = 429
    retryable = True


class LocationQuotaExceededError(LocationServiceError):
    code = "provider_quota_exceeded"
    status_code = 429
    retryable = False


# ------------------------------------------------------------
# Coordinates
# ------------------------------------------------------------

@dataclass(frozen=True)
class Coordinates:
    latitude: float
    longitude: float

    def rounded(self, decimals: int = 3) -> "Coordinates":
        return Coordinates(round(self.latitude, decimals), round(self.longitude, decimals))

    def as_dict(self, decimals: int = 4) -> Dict[str, float]:
        r = self.rounded(decimals)
        return {"latitude": r.latitude, "longitude": r.longitude}


def validate_coordinates(latitude: Any, longitude: Any, *, decimals: Optional[int] = None) -> Coordinates:
    """Validates WGS84 coordinates. Raises a coordinate-free Turkish error."""
    try:
        lat = float(latitude)
        lng = float(longitude)
    except (TypeError, ValueError):
        raise LocationValidationError("Geçersiz konum koordinatı. Lütfen konumunuzu yeniden seçin.")

    if isinstance(latitude, bool) or isinstance(longitude, bool):
        raise LocationValidationError("Geçersiz konum koordinatı. Lütfen konumunuzu yeniden seçin.")
    if not math.isfinite(lat) or not math.isfinite(lng):
        raise LocationValidationError("Geçersiz konum koordinatı. Lütfen konumunuzu yeniden seçin.")
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lng <= 180.0):
        raise LocationValidationError("Konum koordinatları geçerli aralığın dışında.")
    # Reject the null island as a likely client bug / fabricated value.
    if abs(lat) < 1e-9 and abs(lng) < 1e-9:
        raise LocationValidationError("Konum alınamadı. Lütfen konumunuzu yeniden seçin.")

    coords = Coordinates(lat, lng)
    return coords.rounded(decimals) if decimals is not None else coords


def haversine_km(a: Coordinates, b: Coordinates) -> float:
    """Great-circle distance in kilometres."""
    radius = 6371.0088
    lat1, lon1 = math.radians(a.latitude), math.radians(a.longitude)
    lat2, lon2 = math.radians(b.latitude), math.radians(b.longitude)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2.0) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2.0) ** 2
    return 2.0 * radius * math.asin(min(1.0, math.sqrt(h)))


# ------------------------------------------------------------
# TTL cache with stale window
# ------------------------------------------------------------

class TTLCache:
    """Thread-safe in-memory cache. Never persisted to disk."""

    def __init__(self, ttl_seconds: int, *, max_entries: int = 256, stale_seconds: int = 0):
        self.ttl = max(1, int(ttl_seconds))
        self.stale = max(0, int(stale_seconds))
        self.max_entries = max(8, int(max_entries))
        self._lock = threading.Lock()
        self._data: Dict[str, Tuple[float, float, Any]] = {}

    def get(self, key: str) -> Optional[Tuple[Any, int, bool]]:
        now = time.time()
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            stored_at, expires_at, value = item
            age = max(0, int(now - stored_at))
            if now <= expires_at:
                return value, age, True
            if self.stale and now <= expires_at + self.stale:
                return value, age, False
            self._data.pop(key, None)
            return None

    def set(self, key: str, value: Any) -> None:
        now = time.time()
        with self._lock:
            if len(self._data) >= self.max_entries:
                # Remove expired entries, then the oldest one.
                for k in [k for k, (_, exp, _) in self._data.items() if exp + self.stale <= now]:
                    self._data.pop(k, None)
                if len(self._data) >= self.max_entries:
                    oldest = min(self._data.items(), key=lambda kv: kv[1][0])[0]
                    self._data.pop(oldest, None)
            self._data[key] = (now, now + self.ttl, value)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


# ------------------------------------------------------------
# Per-user quota guard (separate from provider quotas)
# ------------------------------------------------------------

class LocationUsageGuard:
    """Sliding-window minute limit plus a daily per-user quota."""

    def __init__(
        self,
        *,
        per_minute: Optional[int] = None,
        per_day: Optional[int] = None,
        guest_per_day: Optional[int] = None,
    ):
        self.per_minute = per_minute if per_minute is not None else _env_int("LUMINA_LOCATION_RATE_LIMIT_PER_MIN", 12)
        self.per_day = per_day if per_day is not None else _env_int("LUMINA_LOCATION_DAILY_PER_USER", 60)
        self.guest_per_day = (
            guest_per_day if guest_per_day is not None else _env_int("LUMINA_LOCATION_DAILY_PER_GUEST", 10)
        )
        self._lock = threading.Lock()
        self._minute: Dict[str, List[float]] = {}
        self._daily: Dict[str, Tuple[str, int]] = {}  # key -> (utc_date, count)

    @staticmethod
    def _day_key() -> str:
        return datetime.now(dt_timezone.utc).strftime("%Y-%m-%d")

    def check(self, user_key: str, *, is_guest: bool = False) -> None:
        if not location_feature_enabled():
            raise LocationConfigurationError("Konum özellikleri bu sunucuda devre dışı.")
        key = f"guest:{user_key}" if is_guest else f"user:{user_key}"
        now = time.time()
        today = self._day_key()
        limit = self.guest_per_day if is_guest else self.per_day
        with self._lock:
            window = [t for t in self._minute.get(key, []) if now - t < 60]
            if len(window) >= self.per_minute:
                self._minute[key] = window
                raise LocationRateLimitError("Çok hızlı konum isteği gönderdin. Lütfen bir dakika sonra tekrar dene.")
            window.append(now)
            self._minute[key] = window

            day, count = self._daily.get(key, (today, 0))
            if day != today:
                day, count = today, 0
            if count >= limit:
                self._daily[key] = (day, count)
                raise LocationQuotaExceededError(
                    "Günlük konum araması sınırına ulaştın. Yarın tekrar deneyebilir veya şehir seçebilirsin."
                )
            self._daily[key] = (day, count + 1)

    def reset(self) -> None:
        with self._lock:
            self._minute.clear()
            self._daily.clear()


class ProviderQuotaGuard:
    """Daily outbound-call ceiling per provider (protects billing)."""

    def __init__(self, defaults: Optional[Dict[str, int]] = None):
        self._defaults = defaults or {
            "google_places": _env_int("LUMINA_GOOGLE_PLACES_DAILY_MAX", 2000),
            "google_geocoding": _env_int("LUMINA_GOOGLE_GEOCODING_DAILY_MAX", 2000),
            "google_routes": _env_int("LUMINA_GOOGLE_ROUTES_DAILY_MAX", 1000),
            "open_meteo": _env_int("LUMINA_OPEN_METEO_DAILY_MAX", 8000),
            "openweather": _env_int("LUMINA_OPENWEATHER_DAILY_MAX", 500),
        }
        self._lock = threading.Lock()
        self._usage: Dict[str, Tuple[str, int]] = {}

    def consume(self, provider: str, amount: int = 1) -> None:
        today = datetime.now(dt_timezone.utc).strftime("%Y-%m-%d")
        limit = self._defaults.get(provider, 1000)
        with self._lock:
            day, used = self._usage.get(provider, (today, 0))
            if day != today:
                day, used = today, 0
            if used + amount > limit:
                self._usage[provider] = (day, used)
                raise LocationQuotaExceededError(
                    "Sağlayıcı günlük kullanım sınırına ulaşıldı. Lütfen daha sonra tekrar dene.",
                    provider=provider,
                )
            self._usage[provider] = (day, used + amount)

    def usage(self) -> Dict[str, Dict[str, Any]]:
        today = datetime.now(dt_timezone.utc).strftime("%Y-%m-%d")
        with self._lock:
            return {
                provider: {
                    "date": day,
                    "used": used,
                    "limit": self._defaults.get(provider, 1000),
                }
                for provider, (day, used) in self._usage.items()
                if day == today
            }

    def reset(self) -> None:
        with self._lock:
            self._usage.clear()


class CircuitBreaker:
    def __init__(self, *, threshold: int = 5, cooldown_seconds: int = 60):
        self.threshold = max(1, threshold)
        self.cooldown = max(5, cooldown_seconds)
        self._lock = threading.Lock()
        self._failures: Dict[str, int] = {}
        self._opened_until: Dict[str, float] = {}

    def before(self, provider: str) -> None:
        now = time.time()
        with self._lock:
            if self._opened_until.get(provider, 0) > now:
                raise LocationUpstreamError(
                    "Konum sağlayıcısı geçici olarak devre dışı. Lütfen bir dakika sonra tekrar dene.",
                    provider=provider,
                )

    def success(self, provider: str) -> None:
        with self._lock:
            self._failures.pop(provider, None)
            self._opened_until.pop(provider, None)

    def failure(self, provider: str) -> None:
        now = time.time()
        with self._lock:
            count = self._failures.get(provider, 0) + 1
            self._failures[provider] = count
            if count >= self.threshold:
                self._opened_until[provider] = now + self.cooldown
                self._failures[provider] = 0

    def reset(self) -> None:
        with self._lock:
            self._failures.clear()
            self._opened_until.clear()


# Module-level guards (tests can replace/reset them).
usage_guard = LocationUsageGuard()
provider_quota = ProviderQuotaGuard()
breaker = CircuitBreaker()


# ------------------------------------------------------------
# Safe outbound HTTP
# ------------------------------------------------------------

def _safe_provider_message(provider: str, status: int) -> str:
    if status in (401, 403):
        return (
            f"{provider} yetkilendirme hatası verdi. Sunucudaki API anahtarı, API etkinleştirmesi "
            "ve faturalandırma yapılandırmasını kontrol edin."
        )
    if status == 429:
        return f"{provider} kotası doldu. Lütfen daha sonra tekrar dene."
    if status == 404:
        return f"{provider} isteği bulunamadı."
    if status == 400:
        return f"{provider} isteği reddetti. Konum veya arama parametrelerini kontrol edin."
    if status >= 500:
        return f"{provider} şu anda yanıt veremiyor. Lütfen tekrar dene."
    return f"{provider} isteği tamamlanamadı."


def request_json(
    method: str,
    url: str,
    *,
    provider: str,
    quota_provider: Optional[str] = None,
    timeout: Optional[float] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    """Performs an outbound request with quota, timeout, breaker and safe errors."""
    breaker.before(provider)
    provider_quota.consume(quota_provider or provider)

    try:
        response = requests.request(method, url, timeout=timeout or http_timeout(), **kwargs)
    except requests.Timeout:
        breaker.failure(provider)
        raise LocationTimeoutError(
            f"{provider} zamanında yanıt vermedi. Lütfen tekrar dene.", provider=provider
        )
    except requests.RequestException:
        # Do not include exception text: it can contain the full URL.
        breaker.failure(provider)
        raise LocationUpstreamError(
            f"{provider} ile bağlantı kurulamadı. Lütfen tekrar dene.", provider=provider
        )

    status = int(getattr(response, "status_code", 0) or 0)
    if status == 200:
        try:
            payload = response.json()
        except ValueError:
            breaker.failure(provider)
            raise LocationUpstreamError(f"{provider} geçersiz bir yanıt döndürdü.", provider=provider)
        breaker.success(provider)
        return payload if isinstance(payload, dict) else {"data": payload}

    if status in (401, 403):
        breaker.failure(provider)
        raise LocationConfigurationError(_safe_provider_message(provider, status), provider=provider)
    if status == 429:
        breaker.failure(provider)
        raise LocationQuotaExceededError(_safe_provider_message(provider, status), provider=provider)
    if status == 404:
        raise LocationNotFoundError(_safe_provider_message(provider, status), provider=provider, retryable=False)
    if status == 400:
        raise LocationValidationError(_safe_provider_message(provider, status), provider=provider)
    if status >= 500:
        breaker.failure(provider)
        raise LocationUpstreamError(_safe_provider_message(provider, status), provider=provider)
    raise LocationUpstreamError(_safe_provider_message(provider, status), provider=provider)


# ------------------------------------------------------------
# Geocoding
# ------------------------------------------------------------

@dataclass
class GeocodeCandidate:
    name: str
    latitude: float
    longitude: float
    admin1: Optional[str] = None
    country: Optional[str] = None
    timezone: Optional[str] = None
    provider: str = "open-meteo"
    formatted_address: Optional[str] = None

    def label(self) -> str:
        parts = [self.name]
        if self.admin1 and self.admin1.casefold() not in self.name.casefold():
            parts.append(self.admin1)
        if self.country and self.country.casefold() not in {p.casefold() for p in parts}:
            parts.append(self.country)
        return ", ".join(parts)

    def to_dict(self, *, with_coordinates: bool = True) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "name": self.name,
            "label": self.label(),
            "admin1": self.admin1,
            "country": self.country,
            "timezone": self.timezone,
            "provider": self.provider,
        }
        if with_coordinates:
            data["latitude"] = round(self.latitude, 5)
            data["longitude"] = round(self.longitude, 5)
        return data


_CITY_QUERY_RE = re.compile(r"[\x00-\x1f\x7f<>]")


def sanitize_place_query(query: str) -> str:
    if not isinstance(query, str):
        raise LocationValidationError("Aranacak yer adı metin olmalıdır.")
    cleaned = _CITY_QUERY_RE.sub("", query).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    if len(cleaned) < 2 or len(cleaned) > 160:
        raise LocationValidationError("Yer adı 2-160 karakter arasında olmalıdır.")
    return cleaned


_geocode_cache = TTLCache(cache_ttl("geocode", 86400), max_entries=512)


def geocode_place(query: str, *, language: str = "tr", limit: int = 5) -> List[GeocodeCandidate]:
    """Resolves a city/address. Google Geocoding first, Open-Meteo as fallback."""
    cleaned = sanitize_place_query(query)
    limit = max(1, min(10, int(limit or 5)))
    cache_key = f"geocode:{language}:{limit}:{cleaned.casefold()}"
    cached = _geocode_cache.get(cache_key)
    if cached:
        return list(cached[0])

    candidates: List[GeocodeCandidate] = []
    key = google_maps_api_key()

    if key:
        try:
            payload = request_json(
                "GET",
                "https://maps.googleapis.com/maps/api/geocode/json",
                provider="google_geocoding",
                params={
                    "address": cleaned,
                    "key": key,
                    "language": language,
                    "region": "tr",
                },
            )
            status = str(payload.get("status") or "")
            if status in ("OK", "ZERO_RESULTS"):
                for item in list(payload.get("results") or [])[:limit]:
                    loc = ((item.get("geometry") or {}).get("location") or {})
                    try:
                        coords = validate_coordinates(loc.get("lat"), loc.get("lng"))
                    except LocationServiceError:
                        continue
                    components = _google_components(item)
                    candidates.append(
                        GeocodeCandidate(
                            name=components.get("locality")
                            or components.get("administrative_area_level_2")
                            or item.get("formatted_address")
                            or cleaned,
                            latitude=coords.latitude,
                            longitude=coords.longitude,
                            admin1=components.get("administrative_area_level_1"),
                            country=components.get("country"),
                            timezone=None,
                            provider="google_geocoding",
                            formatted_address=item.get("formatted_address"),
                        )
                    )
            elif status == "OVER_QUERY_LIMIT":
                raise LocationQuotaExceededError("Google Geocoding kotası doldu.", provider="google_geocoding")
            elif status in ("REQUEST_DENIED", "INVALID_REQUEST"):
                raise LocationConfigurationError(
                    "Google Geocoding anahtarı veya API etkinleştirmesi geçersiz.",
                    provider="google_geocoding",
                )
            if candidates:
                _geocode_cache.set(cache_key, candidates)
                return candidates
        except LocationServiceError:
            # Fall back to the keyless Open-Meteo geocoder when enabled.
            if _env_str("LUMINA_ALLOW_OPEN_METEO_GEOCODING", "1") in {"0", "false", "False"}:
                raise

    if _env_str("LUMINA_ALLOW_OPEN_METEO_GEOCODING", "1") in {"0", "false", "False"}:
        if not candidates:
            raise LocationConfigurationError(
                "Geocoding sağlayıcısı yapılandırılmadı. GOOGLE_MAPS_API_KEY gerekli.",
                provider="geocoding",
            )

    payload = request_json(
        "GET",
        "https://geocoding-api.open-meteo.com/v1/search",
        provider="open_meteo",
        params={
            "name": cleaned,
            "count": limit,
            "language": language,
            "format": "json",
        },
    )
    for item in list(payload.get("results") or [])[:limit]:
        try:
            coords = validate_coordinates(item.get("latitude"), item.get("longitude"))
        except LocationServiceError:
            continue
        candidates.append(
            GeocodeCandidate(
                name=str(item.get("name") or cleaned)[:120],
                latitude=coords.latitude,
                longitude=coords.longitude,
                admin1=(str(item.get("admin1"))[:120] if item.get("admin1") else None),
                country=(str(item.get("country"))[:120] if item.get("country") else None),
                timezone=(str(item.get("timezone"))[:80] if item.get("timezone") else None),
                provider="open_meteo_geocoding",
            )
        )

    if not candidates:
        raise LocationNotFoundError(f"'{cleaned}' için konum bulunamadı. Farklı bir şehir adı dene.")
    _geocode_cache.set(cache_key, candidates)
    return candidates


def _google_components(item: Dict[str, Any]) -> Dict[str, str]:
    wanted = {
        "locality",
        "administrative_area_level_1",
        "administrative_area_level_2",
        "country",
        "postal_town",
    }
    result: Dict[str, str] = {}
    for comp in item.get("address_components") or []:
        for kind in comp.get("types") or []:
            if kind in wanted and kind not in result:
                result[kind] = str(comp.get("long_name") or "")[:120]
    return result


def reverse_geocode(coords: Coordinates, *, language: str = "tr") -> Optional[Dict[str, str]]:
    """Resolves a human label for coordinates.

    Uses Google Geocoding when a server key is configured, otherwise the
    keyless OpenStreetMap Nominatim service. Returns None when neither
    provider yields a usable label; callers must present a clear
    limitation instead of inventing an address.
    """
    key = google_maps_api_key()
    safe = coords.rounded(3)
    cache_key = f"reverse:{'google' if key else 'osm'}:{language}:{safe.latitude}:{safe.longitude}"
    cached = _geocode_cache.get(cache_key)
    if cached:
        return dict(cached[0])

    if not key:
        data = _nominatim_reverse(safe, language)
        if data:
            _geocode_cache.set(cache_key, data)
        return data

    payload = request_json(
        "GET",
        "https://maps.googleapis.com/maps/api/geocode/json",
        provider="google_geocoding",
        params={
            "latlng": f"{safe.latitude},{safe.longitude}",
            "key": key,
            "language": language,
            "result_type": "locality|administrative_area_level_1|country",
        },
    )
    if str(payload.get("status") or "") not in ("OK", "ZERO_RESULTS"):
        return None
    results = list(payload.get("results") or [])
    if not results:
        return None
    item = results[0]
    comps = _google_components(item)
    label = comps.get("locality") or comps.get("administrative_area_level_2") or item.get("formatted_address")
    if not label:
        return None
    data = {
        "label": str(label)[:160],
        "city": str(comps.get("locality") or comps.get("administrative_area_level_2") or "")[:120],
        "country": str(comps.get("country") or "")[:120],
        "formatted_address": str(item.get("formatted_address") or "")[:240],
        "provider": "google_geocoding",
    }
    _geocode_cache.set(cache_key, data)
    return data


def _nominatim_reverse(coords: Coordinates, language: str) -> Optional[Dict[str, str]]:
    """Keyless reverse geocoding via OpenStreetMap Nominatim."""
    try:
        payload = request_json(
            "GET",
            "https://nominatim.openstreetmap.org/reverse",
            provider="osm_nominatim",
            timeout=12,
            headers={
                "User-Agent": (os.getenv("LUMINA_OSM_USER_AGENT") or "LuminaAI/3.2.4 (OSM fallback)")[:160],
                "Accept-Language": "tr",
            },
            params={
                "lat": coords.latitude,
                "lon": coords.longitude,
                "format": "jsonv2",
                "zoom": 10,
                "addressdetails": 1,
                "accept-language": language,
            },
        )
    except LocationServiceError:
        return None
    if not isinstance(payload, dict) or payload.get("error"):
        return None
    address = payload.get("address") if isinstance(payload.get("address"), dict) else {}
    city = (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("state")
        or payload.get("name")
    )
    label = city or payload.get("display_name")
    if not label:
        return None
    return {
        "label": str(label)[:160],
        "city": str(city or "")[:120],
        "country": str(address.get("country") or "")[:120],
        "formatted_address": str(payload.get("display_name") or "")[:240],
        "provider": "osm_nominatim",
    }


# ------------------------------------------------------------
# Status (never exposes secrets)
# ------------------------------------------------------------

def provider_status() -> Dict[str, Any]:
    return {
        "enabled": location_feature_enabled(),
        "google_maps_server_key": bool(google_maps_api_key()),
        "google_maps_browser_key": bool(google_maps_js_api_key()),
        "open_meteo_key": bool(open_meteo_api_key()),
        "openweather_key": bool(openweather_api_key()),
        "geocoding_fallback": _env_str("LUMINA_ALLOW_OPEN_METEO_GEOCODING", "1") not in {"0", "false", "False"},
        "reverse_geocoding_fallback": "OpenStreetMap Nominatim" if not google_maps_api_key() else None,
        "http_timeout_seconds": http_timeout(),
        "provider_quota_usage": provider_quota.usage(),
    }


def reset_runtime_state() -> None:
    """Testing helper; does not touch environment variables."""
    usage_guard.reset()
    provider_quota.reset()
    breaker.reset()
    _geocode_cache.clear()
