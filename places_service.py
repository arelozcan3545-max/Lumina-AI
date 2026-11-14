# ============================================================
# LUMINA AI - PLACES SERVICE (GOOGLE PLACES API - NEW + OSM)
# ------------------------------------------------------------
# Nearby and text search are normalized into a single shape.
# Ranking deliberately keeps "nearest" and "highest-rated" separate
# and exposes the exact criteria used for the blended recommendation.
#
# PROVIDERS
#   * Google Places API (New) when GOOGLE_MAPS_API_KEY is set.
#   * OpenStreetMap fallback (Overpass for nearby, Nominatim for text)
#     when no Google key is configured. OSM has no ratings/review
#     counts, so those fields stay empty and the notice says so.
# ============================================================

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

from location_service import (
    Coordinates,
    LocationConfigurationError,
    LocationServiceError,
    LocationValidationError,
    TTLCache,
    cache_ttl,
    google_maps_api_key,
    haversine_km,
    request_json,
    utc_now_iso,
    validate_coordinates,
)

OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OSM_NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OSM_SOURCE = "OpenStreetMap (Overpass / Nominatim) · © OpenStreetMap katkıda bulunanlar (ODbL)"
OSM_NOTICE_RATINGS = (
    "OpenStreetMap işletme kayıtlarında puan ve yorum sayısı bulunmaz; "
    "bu alanlar bilinçli olarak boş bırakıldı."
)


def _osm_user_agent() -> str:
    return (os.getenv("LUMINA_OSM_USER_AGENT") or "LuminaAI/3.2.4 (OSM fallback)").strip()[:160]


# Canonical category -> list of OSM tag filters. Each entry is
# (key, value, extra_tags). Multiple entries are OR-ed in Overpass.
CATEGORY_OSM_TAGS: Dict[str, List[Tuple[str, str, Dict[str, str]]]] = {
    "vegan": [("amenity", "restaurant", {"diet:vegan": "yes"}), ("amenity", "fast_food", {"diet:vegan": "yes"})],
    "vegetarian": [("amenity", "restaurant", {"diet:vegetarian": "yes"}), ("amenity", "fast_food", {"diet:vegetarian": "yes"})],
    "restaurant": [("amenity", "restaurant", {})],
    "cafe": [("amenity", "cafe", {})],
    "bakery": [("shop", "bakery", {}), ("amenity", "bakery", {})],
    "bar": [("amenity", "bar", {}), ("amenity", "pub", {})],
    "hospital": [("amenity", "hospital", {})],
    "pharmacy": [("amenity", "pharmacy", {})],
    "dentist": [("amenity", "dentist", {}), ("healthcare", "dentist", {})],
    "doctor": [("amenity", "doctors", {}), ("healthcare", "doctor", {})],
    "shopping_mall": [("shop", "mall", {})],
    "supermarket": [("shop", "supermarket", {})],
    "hotel": [("tourism", "hotel", {})],
    "tourist_attraction": [("tourism", "attraction", {})],
    "museum": [("tourism", "museum", {})],
    "park": [("leisure", "park", {})],
    "cinema": [("amenity", "cinema", {})],
    "gym": [("leisure", "fitness_centre", {})],
    "atm": [("amenity", "atm", {})],
    "bank": [("amenity", "bank", {})],
    "gas_station": [("amenity", "fuel", {})],
    "parking": [("amenity", "parking", {})],
    "transit_station": [("public_transport", "station", {}), ("highway", "bus_stop", {})],
    "police": [("amenity", "police", {})],
    "post_office": [("amenity", "post_office", {})],
    "hair_salon": [("shop", "hairdresser", {}), ("shop", "beauty", {})],
}

# Canonical categories -> Google Places (New) Table A types.
CATEGORY_TYPES: Dict[str, List[str]] = {
    "vegan": ["vegan_restaurant", "vegetarian_restaurant"],
    "vegetarian": ["vegetarian_restaurant", "vegan_restaurant"],
    "restaurant": ["restaurant"],
    "cafe": ["cafe"],
    "bakery": ["bakery"],
    "bar": ["bar"],
    "hospital": ["hospital"],
    "pharmacy": ["pharmacy"],
    "dentist": ["dentist"],
    "doctor": ["doctor"],
    "shopping_mall": ["shopping_mall"],
    "supermarket": ["supermarket"],
    "hotel": ["hotel"],
    "tourist_attraction": ["tourist_attraction"],
    "museum": ["museum"],
    "park": ["park"],
    "cinema": ["movie_theater"],
    "gym": ["gym"],
    "atm": ["atm"],
    "bank": ["bank"],
    "gas_station": ["gas_station"],
    "parking": ["parking"],
    "transit_station": ["transit_station"],
    "police": ["police"],
    "post_office": ["post_office"],
    "hair_salon": ["hair_salon", "beauty_salon"],
}

CATEGORY_LABELS_TR: Dict[str, str] = {
    "vegan": "Vegan / vejetaryen restoran",
    "vegetarian": "Vejetaryen restoran",
    "restaurant": "Restoran",
    "cafe": "Kafe",
    "bakery": "Fırın",
    "bar": "Bar",
    "hospital": "Hastane",
    "pharmacy": "Eczane",
    "dentist": "Diş hekimi",
    "doctor": "Doktor",
    "shopping_mall": "Alışveriş merkezi",
    "supermarket": "Süpermarket",
    "hotel": "Otel",
    "tourist_attraction": "Turistik yer",
    "museum": "Müze",
    "park": "Park",
    "cinema": "Sinema",
    "gym": "Spor salonu",
    "atm": "ATM",
    "bank": "Banka",
    "gas_station": "Benzin istasyonu",
    "parking": "Otopark",
    "transit_station": "Toplu taşıma durağı",
    "police": "Polis merkezi",
    "post_office": "Postane",
    "hair_salon": "Berber / kuaför",
}

DEFAULT_RADIUS_M: Dict[str, int] = {
    "vegan": 2500,
    "vegetarian": 2500,
    "restaurant": 2000,
    "cafe": 1500,
    "bakery": 1500,
    "bar": 1500,
    "hospital": 6000,
    "pharmacy": 2000,
    "dentist": 4000,
    "doctor": 4000,
    "shopping_mall": 6000,
    "supermarket": 2500,
    "hotel": 6000,
    "tourist_attraction": 6000,
    "museum": 6000,
    "park": 4000,
    "cinema": 4000,
    "gym": 3000,
    "atm": 1200,
    "bank": 2000,
    "gas_station": 3000,
    "parking": 1500,
    "transit_station": 2000,
    "police": 5000,
    "post_office": 3000,
    "hair_salon": 2500,
}

PRICE_LABELS_TR = {
    "PRICE_LEVEL_FREE": "Ücretsiz",
    "PRICE_LEVEL_INEXPENSIVE": "Uygun",
    "PRICE_LEVEL_MODERATE": "Orta",
    "PRICE_LEVEL_EXPENSIVE": "Pahalı",
    "PRICE_LEVEL_VERY_EXPENSIVE": "Çok pahalı",
}

PLACES_FIELD_MASK = ",".join(
    [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.rating",
        "places.userRatingCount",
        "places.priceLevel",
        "places.types",
        "places.primaryTypeDisplayName",
        "places.googleMapsUri",
        "places.websiteUri",
        "places.nationalPhoneNumber",
        "places.businessStatus",
    ]
)

_places_cache = TTLCache(cache_ttl("places", 300), max_entries=256)


def normalize_category(category: str) -> str:
    key = (category or "").strip().casefold()
    if key not in CATEGORY_TYPES:
        raise LocationValidationError("Desteklenmeyen mekân kategorisi.")
    return key


def default_radius_m(category: str) -> int:
    return DEFAULT_RADIUS_M.get(normalize_category(category), 2500)


def _normalize_place(raw: Dict[str, Any], center: Optional[Coordinates]) -> Optional[Dict[str, Any]]:
    loc = raw.get("location") or {}
    try:
        coords = validate_coordinates(loc.get("latitude"), loc.get("longitude"))
    except LocationServiceError:
        return None

    display = raw.get("displayName") or {}
    name = str(display.get("text") or "").strip()
    if not name:
        return None

    rating = raw.get("rating")
    try:
        rating = float(rating) if rating is not None else None
    except (TypeError, ValueError):
        rating = None
    if rating is not None and not (0 <= rating <= 5):
        rating = None

    reviews = raw.get("userRatingCount")
    try:
        reviews = int(reviews) if reviews is not None else None
    except (TypeError, ValueError):
        reviews = None
    if reviews is not None and reviews < 0:
        reviews = None

    price = raw.get("priceLevel")
    price_label = PRICE_LABELS_TR.get(str(price), None) if price else None

    primary = raw.get("primaryTypeDisplayName") or {}
    category_label = str(primary.get("text") or "").strip() or None

    distance = round(haversine_km(center, coords), 2) if center else None

    return {
        "id": str(raw.get("id") or raw.get("name") or "")[:120],
        "name": name[:160],
        "address": str(raw.get("formattedAddress") or "")[:240] or "Adres bilgisi yok",
        "rating": round(rating, 1) if rating is not None else None,
        "review_count": reviews,
        "distance_km": distance,
        "price_level": price_label,
        "category_label": category_label,
        "latitude": round(coords.latitude, 5),
        "longitude": round(coords.longitude, 5),
        "google_maps_url": str(raw.get("googleMapsUri") or "")[:800] or None,
        "website": str(raw.get("websiteUri") or "")[:800] or None,
        "phone": str(raw.get("nationalPhoneNumber") or "")[:40] or None,
        "business_status": str(raw.get("businessStatus") or "")[:40] or None,
        "types": [str(t)[:60] for t in (raw.get("types") or [])[:12]],
    }


def rank_places(places: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Returns nearest / top-rated / blended lists with explicit criteria."""
    valid = [p for p in places if p.get("latitude") is not None and p.get("longitude") is not None]
    nearest = sorted(valid, key=lambda p: (p.get("distance_km") is None, p.get("distance_km") or 0))[:10]

    rated = [p for p in valid if p.get("rating") is not None]
    top_rated = sorted(
        rated,
        key=lambda p: (-(p.get("rating") or 0), -(p.get("review_count") or 0), p.get("distance_km") or 0),
    )[:10]

    distances = [float(p["distance_km"]) for p in valid if p.get("distance_km") is not None]
    max_distance = max(distances) if distances else 1.0
    max_distance = max(max_distance, 0.5)

    def score(p: Dict[str, Any]) -> float:
        rating = p.get("rating")
        distance = p.get("distance_km")
        proximity = 0.0 if distance is None else 1.0 - min(float(distance) / max_distance, 1.0)
        if rating is None:
            # Unrated places are never ranked above rated places in the
            # blended recommendation; proximity only breaks ties.
            return 0.1 * proximity
        return 0.65 * (float(rating) / 5.0) + 0.35 * proximity

    blended = sorted(
        valid,
        key=lambda p: (
            # Hard partition: rated places always rank above unrated ones,
            # regardless of how low the numeric rating is.
            p.get("rating") is None,
            -(score(p)),
            -(p.get("review_count") or 0),
            p.get("distance_km") if p.get("distance_km") is not None else 10**9,
        ),
    )[:10]

    explanation = (
        "Öneri sıralaması: %65 puan (5 üzerinden) + %35 yakınlık. "
        "Yakınlık, en uzak sonuca göre normalize edilir. Puanı olmayan işletmeler "
        "öneri listesinde puanlı işletmelerin üstüne çıkarılmaz. "
        "'En yakın' listesi yalnızca mesafeye, 'En yüksek puanlı' listesi puan ve yorum sayısına göre sıralanır."
    )

    return {
        "nearest": nearest,
        "top_rated": top_rated,
        "recommended": blended,
        "best_match_id": blended[0].get("id") if blended else None,
        "nearest_id": nearest[0].get("id") if nearest else None,
        "top_rated_id": top_rated[0].get("id") if top_rated else None,
        "ranking_explanation": explanation,
    }


def _require_google_key() -> str:
    key = google_maps_api_key()
    if not key:
        raise LocationConfigurationError(
            "Google Places entegrasyonu için sunucuda GOOGLE_MAPS_API_KEY tanımlı olmalı. "
            "Mekân araması bu anahtar olmadan yapılamaz.",
            provider="google_places",
        )
    return key


# ------------------------------------------------------------
# OpenStreetMap fallback (no API key required)
# ------------------------------------------------------------

def _overpass_nearby_query(category_key: str, center: Coordinates, radius: int) -> str:
    parts: List[str] = []
    for key, value, extra in CATEGORY_OSM_TAGS[category_key]:
        tag = f'["{key}"="{value}"]'
        for extra_key, extra_value in extra.items():
            tag += f'["{extra_key}"="{extra_value}"]'
        for selector in ("node", "way", "relation"):
            parts.append(
                f"{selector}{tag}(around:{radius},{center.latitude},{center.longitude});"
            )
    return "[out:json][timeout:20];(" + "".join(parts) + ");out center tags 80;"


def _osm_element_coords(raw: Dict[str, Any]) -> Tuple[Any, Any]:
    if raw.get("lat") is not None and raw.get("lon") is not None:
        return raw.get("lat"), raw.get("lon")
    center = raw.get("center") or {}
    return center.get("lat"), center.get("lon")


def _osm_address(tags: Dict[str, Any], fallback: Optional[str] = None) -> str:
    street = str(tags.get("addr:street") or "").strip()
    number = str(tags.get("addr:housenumber") or "").strip()
    line = " ".join(part for part in (street, number) if part).strip()
    locality = (
        tags.get("addr:neighbourhood")
        or tags.get("addr:suburb")
        or tags.get("addr:district")
        or tags.get("addr:city")
        or tags.get("addr:town")
        or tags.get("addr:village")
    )
    locality_text = str(locality or "").strip()
    if line and locality_text:
        return f"{line}, {locality_text}"[:240]
    if line:
        return line[:240]
    if locality_text:
        return locality_text[:240]
    if fallback:
        return str(fallback)[:240]
    return "Adres bilgisi yok"


def _normalize_osm_place(
    raw: Dict[str, Any],
    center: Optional[Coordinates],
    *,
    category_label: str,
    from_nominatim: bool = False,
) -> Optional[Dict[str, Any]]:
    tags = raw.get("tags") if isinstance(raw.get("tags"), dict) else {}
    address_info = raw.get("address") if isinstance(raw.get("address"), dict) else {}

    if from_nominatim:
        lat, lon = raw.get("lat"), raw.get("lon")
        display_name = raw.get("display_name")
        name = (
            str(raw.get("name") or "").strip()
            or str(tags.get("name") or "").strip()
            or (str(display_name).split(",")[0].strip() if display_name else "")
        )
        osm_type = str(raw.get("osm_type") or "").strip()
        osm_id = str(raw.get("osm_id") or "").strip()
    else:
        lat, lon = _osm_element_coords(raw)
        display_name = None
        name = (
            str(tags.get("name:tr") or "").strip()
            or str(tags.get("name") or "").strip()
            or str(tags.get("brand") or "").strip()
            or str(tags.get("operator") or "").strip()
        )
        osm_type = str(raw.get("type") or "").strip()
        osm_id = str(raw.get("id") or "").strip()

    if not name:
        return None
    try:
        coords = validate_coordinates(lat, lon)
    except LocationServiceError:
        return None

    if from_nominatim:
        address = _osm_address(address_info, fallback=display_name)
    else:
        address = _osm_address(tags)

    map_url = (
        f"https://www.openstreetmap.org/{osm_type}/{osm_id}"
        if osm_type and osm_id
        else None
    )
    website = str(tags.get("website") or tags.get("contact:website") or "").strip()[:800] or None
    phone = str(tags.get("phone") or tags.get("contact:phone") or "").strip()[:40] or None

    return {
        "id": f"osm:{osm_type or 'place'}:{osm_id or name}"[:120],
        "name": name[:160],
        "address": address,
        "rating": None,
        "review_count": None,
        "distance_km": round(haversine_km(center, coords), 2) if center else None,
        "price_level": None,
        "category_label": category_label,
        "latitude": round(coords.latitude, 5),
        "longitude": round(coords.longitude, 5),
        "google_maps_url": map_url,
        "website": website,
        "phone": phone,
        "business_status": None,
        "types": sorted({str(k)[:60] for k in tags.keys()})[:12] if tags else [],
    }


def _osm_search_nearby(
    category_key: str,
    center: Coordinates,
    radius: int,
    max_results: int,
) -> Dict[str, Any]:
    cache_key = (
        f"osm:nearby:{category_key}:{center.latitude}:{center.longitude}:"
        f"{radius}:{max_results}"
    )
    cached = _places_cache.get(cache_key)
    if cached:
        value = dict(cached[0])
        value["cached"] = True
        value["cache_age_seconds"] = cached[1]
        return value

    payload = request_json(
        "POST",
        OSM_OVERPASS_URL,
        provider="osm_overpass",
        timeout=25,
        headers={
            "User-Agent": _osm_user_agent(),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={"data": _overpass_nearby_query(category_key, center, radius)},
    )
    category_label = CATEGORY_LABELS_TR[category_key]
    elements = list(payload.get("elements") or [])
    places = [
        p
        for p in (
            _normalize_osm_place(item, center, category_label=category_label)
            for item in elements
        )
        if p
    ][:max_results]

    ranking = rank_places(places)
    result = {
        "success": True,
        "category": category_key,
        "category_label": category_label,
        "radius_m": radius,
        "center": center.as_dict(4),
        "places": ranking["recommended"],
        "nearest": ranking["nearest"],
        "top_rated": ranking["top_rated"],
        "best_match_id": ranking["best_match_id"],
        "nearest_id": ranking["nearest_id"],
        "top_rated_id": ranking["top_rated_id"],
        "ranking_explanation": (
            "OpenStreetMap kayıtlarında puan/yorum bulunmadığı için 'En yüksek puanlı' listesi boş kalır. "
            "Öneri sıralaması yalnızca mesafeye dayanır."
        ),
        "source": OSM_SOURCE,
        "fetched_at": utc_now_iso(),
        "cached": False,
        "cache_age_seconds": 0,
        "notice": OSM_NOTICE_RATINGS
        if places
        else (
            "Bu yarıçapta OpenStreetMap üzerinde eşleşen işletme bulunamadı. "
            "Yarıçapı artırmayı veya farklı bir kategori denemeyi öner."
        ),
    }
    _places_cache.set(cache_key, result)
    return result


def _osm_search_text(
    query: str,
    *,
    center: Optional[Coordinates],
    max_results: int,
) -> Dict[str, Any]:
    q = (query or "").strip()
    if len(q) < 2 or len(q) > 240:
        raise LocationValidationError("Arama metni 2-240 karakter arasında olmalıdır.")
    center_safe = center.rounded(3) if center else None
    cache_key = f"osm:text:{max_results}:{center_safe.latitude if center_safe else '-'}:{q.casefold()}"
    cached = _places_cache.get(cache_key)
    if cached:
        value = dict(cached[0])
        value["cached"] = True
        value["cache_age_seconds"] = cached[1]
        return value

    payload = request_json(
        "GET",
        OSM_NOMINATIM_URL,
        provider="osm_nominatim",
        timeout=15,
        headers={
            "User-Agent": _osm_user_agent(),
            "Accept-Language": "tr",
        },
        params={
            "q": q,
            "format": "jsonv2",
            "addressdetails": 1,
            "limit": max_results,
            "accept-language": "tr",
        },
    )
    raw_items = payload.get("data")
    if not isinstance(raw_items, list):
        raw_items = list(payload.get("results") or [])
    category_label = "Metin araması (OpenStreetMap)"
    places = [
        p
        for p in (
            _normalize_osm_place(
                item,
                center_safe,
                category_label=category_label,
                from_nominatim=True,
            )
            for item in raw_items
            if isinstance(item, dict)
        )
        if p
    ][:max_results]

    ranking = rank_places(places)
    result = {
        "success": True,
        "category": "text_search",
        "category_label": category_label,
        "radius_m": None,
        "center": center_safe.as_dict(4) if center_safe else None,
        "places": ranking["recommended"],
        "nearest": ranking["nearest"],
        "top_rated": ranking["top_rated"],
        "best_match_id": ranking["best_match_id"],
        "nearest_id": ranking["nearest_id"],
        "top_rated_id": ranking["top_rated_id"],
        "ranking_explanation": (
            "OpenStreetMap aramasında puan/yorum verisi yoktur; sıralama mesafeye dayanır."
        ),
        "source": OSM_SOURCE,
        "fetched_at": utc_now_iso(),
        "cached": False,
        "cache_age_seconds": 0,
        "notice": OSM_NOTICE_RATINGS if places else "Aramanla eşleşen işletme bulunamadı.",
    }
    _places_cache.set(cache_key, result)
    return result


def search_nearby(
    category: str,
    center: Coordinates,
    *,
    radius_m: Optional[int] = None,
    max_results: int = 10,
    language: str = "tr",
) -> Dict[str, Any]:
    """Searches Google Places (New) Nearby Search and returns ranked results.

    Falls back to OpenStreetMap (Overpass) when no Google key is configured.
    """
    category_key = normalize_category(category)
    center_safe = center.rounded(3)  # ~110 m precision is enough for a 1-6 km radius.
    radius = int(radius_m or default_radius_m(category_key))
    if radius < 200 or radius > 50000:
        raise LocationValidationError("Arama yarıçapı 200-50000 metre arasında olmalıdır.")
    max_results = max(1, min(20, int(max_results or 10)))
    lang = (language or "tr")[:8]

    if not google_maps_api_key():
        return _osm_search_nearby(category_key, center_safe, radius, max_results)

    key = _require_google_key()

    cache_key = (
        f"nearby:{category_key}:{center_safe.latitude}:{center_safe.longitude}:"
        f"{radius}:{max_results}:{lang}"
    )
    cached = _places_cache.get(cache_key)
    if cached:
        value = dict(cached[0])
        value["cached"] = True
        value["cache_age_seconds"] = cached[1]
        return value

    payload = request_json(
        "POST",
        "https://places.googleapis.com/v1/places:searchNearby",
        provider="google_places",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": PLACES_FIELD_MASK,
        },
        json={
            "includedTypes": CATEGORY_TYPES[category_key],
            "maxResultCount": max_results,
            "rankPreference": "DISTANCE",
            "languageCode": lang,
            "regionCode": "TR",
            "locationRestriction": {
                "circle": {
                    "center": {
                        "latitude": center_safe.latitude,
                        "longitude": center_safe.longitude,
                    },
                    "radius": float(radius),
                }
            },
        },
    )

    raw_places = list(payload.get("places") or [])[:max_results]
    places = [p for p in (_normalize_place(item, center_safe) for item in raw_places) if p]
    ranking = rank_places(places)
    result = {
        "success": True,
        "category": category_key,
        "category_label": CATEGORY_LABELS_TR[category_key],
        "radius_m": radius,
        "center": center_safe.as_dict(4),
        "places": ranking["recommended"],
        "nearest": ranking["nearest"],
        "top_rated": ranking["top_rated"],
        "best_match_id": ranking["best_match_id"],
        "nearest_id": ranking["nearest_id"],
        "top_rated_id": ranking["top_rated_id"],
        "ranking_explanation": ranking["ranking_explanation"],
        "source": "Google Places API (New) - Nearby Search",
        "fetched_at": utc_now_iso(),
        "cached": False,
        "cache_age_seconds": 0,
        "notice": None
        if places
        else "Bu yarıçapta eşleşen işletme bulunamadı. Yarıçapı artırmayı veya farklı bir kategori denemeyi öner.",
    }
    _places_cache.set(cache_key, result)
    return result


def search_text(
    query: str,
    *,
    center: Optional[Coordinates] = None,
    max_results: int = 8,
    language: str = "tr",
) -> Dict[str, Any]:
    """Google Places (New) Text Search. Used for named-address queries.

    Falls back to OpenStreetMap Nominatim when no Google key is configured.
    """
    q = (query or "").strip()
    if len(q) < 2 or len(q) > 240:
        raise LocationValidationError("Arama metni 2-240 karakter arasında olmalıdır.")
    max_results = max(1, min(20, int(max_results or 8)))
    lang = (language or "tr")[:8]
    center_safe = center.rounded(3) if center else None

    if not google_maps_api_key():
        return _osm_search_text(q, center=center_safe, max_results=max_results)

    key = _require_google_key()

    body: Dict[str, Any] = {
        "textQuery": q,
        "maxResultCount": max_results,
        "languageCode": lang,
        "regionCode": "TR",
    }
    if center_safe:
        body["locationBias"] = {
            "circle": {
                "center": {"latitude": center_safe.latitude, "longitude": center_safe.longitude},
                "radius": 5000.0,
            }
        }
    cache_key = f"text:{lang}:{max_results}:{center_safe.latitude if center_safe else '-'}:{q.casefold()}"
    cached = _places_cache.get(cache_key)
    if cached:
        value = dict(cached[0])
        value["cached"] = True
        value["cache_age_seconds"] = cached[1]
        return value

    payload = request_json(
        "POST",
        "https://places.googleapis.com/v1/places:searchText",
        provider="google_places",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": PLACES_FIELD_MASK,
        },
        json=body,
    )
    anchor = center_safe or None
    raw_places = list(payload.get("places") or [])[:max_results]
    places = [p for p in (_normalize_place(item, anchor) for item in raw_places) if p]
    ranking = rank_places(places)
    result = {
        "success": True,
        "category": "text_search",
        "category_label": "Metin araması",
        "radius_m": None,
        "center": center_safe.as_dict(4) if center_safe else None,
        "places": ranking["recommended"],
        "nearest": ranking["nearest"],
        "top_rated": ranking["top_rated"],
        "best_match_id": ranking["best_match_id"],
        "nearest_id": ranking["nearest_id"],
        "top_rated_id": ranking["top_rated_id"],
        "ranking_explanation": ranking["ranking_explanation"],
        "source": "Google Places API (New) - Text Search",
        "fetched_at": utc_now_iso(),
        "cached": False,
        "cache_age_seconds": 0,
        "notice": None if places else "Aramanla eşleşen işletme bulunamadı.",
    }
    _places_cache.set(cache_key, result)
    return result


def comparison_block(result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Builds a Smart UI comparison_table block from rated places."""
    places = [p for p in (result.get("places") or []) if p.get("rating") is not None][:4]
    if len(places) < 2:
        return None
    rows: List[List[str]] = []
    for p in places:
        rows.append(
            [
                str(p.get("name") or "")[:80],
                f"{p.get('rating'):.1f} / 5" if p.get("rating") is not None else "-",
                str(p.get("review_count") if p.get("review_count") is not None else "-"),
                f"{p.get('distance_km'):.2f} km" if p.get("distance_km") is not None else "-",
                str(p.get("address") or "")[:120],
            ]
        )
    return {
        "type": "comparison_table",
        "title": f"{result.get('category_label') or 'Mekân'} karşılaştırması",
        "description": "Puan, yorum sayısı ve mesafe ayrı gösterilir; hiçbiri diğerinin yerine geçmez.",
        "data": {
            "headers": ["İşletme", "Puan", "Yorum", "Mesafe", "Adres"],
            "rows": rows,
        },
    }


def places_status() -> Dict[str, Any]:
    google_ready = bool(google_maps_api_key())
    return {
        # Nearby/text search is available even without Google via OSM.
        "configured": True,
        "provider": "Google Places API (New)" if google_ready else "OpenStreetMap (Overpass / Nominatim)",
        "google_configured": google_ready,
        "fallback_provider": None if google_ready else "OpenStreetMap",
        "categories": sorted(CATEGORY_TYPES.keys()),
        "cache_entries": len(_places_cache),
    }
