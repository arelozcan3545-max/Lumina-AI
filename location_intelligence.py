# ============================================================
# LUMINA AI - LOCATION INTELLIGENCE (TURKISH INTENT + ORCHESTRATION)
# ------------------------------------------------------------
# Turns a Turkish chat message into a real, provider-backed
# location / weather / route answer.
#
# DESIGN
#   * Deterministic intent detection (no model guesswork).
#   * Every block is built from live provider data and then run
#     through smart_ui.validate_smart_ui_block.
#   * When data cannot be fetched, no block is produced and the
#     context tells the model to state the limitation honestly.
# ============================================================

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from location_permission_service import (
    STATE_DENIED,
    STATE_OFF,
    STATE_UNSET,
    preference_coordinates,
    public_preference,
    resolve_request_origin,
)
from location_service import (
    Coordinates,
    LocationServiceError,
    geocode_place,
    reverse_geocode,
    usage_guard,
    utc_now_iso,
    validate_coordinates,
)
from places_service import (
    CATEGORY_LABELS_TR,
    comparison_block,
    default_radius_m,
    search_nearby,
    search_text,
)
from routes_service import compute_route
from smart_ui import validate_smart_ui_block
from weather_service import forecast, select_target_day

# ------------------------------------------------------------
# Turkish normalisation helpers
# ------------------------------------------------------------

_FOLD_MAP = str.maketrans(
    {
        "ç": "c",
        "Ç": "c",
        "ğ": "g",
        "Ğ": "g",
        "ı": "i",
        "I": "i",
        "İ": "i",
        "ö": "o",
        "Ö": "o",
        "ş": "s",
        "Ş": "s",
        "ü": "u",
        "Ü": "u",
        "â": "a",
        "î": "i",
        "û": "u",
    }
)


def fold_tr(text: str) -> str:
    """Diacritic-insensitive lowercase folding for intent matching."""
    return (text or "").translate(_FOLD_MAP).lower()


# 81 provinces (folded). Used for explicit city detection only.
_PROVINCES_FOLDED = {
    "adana", "adiyaman", "afyonkarahisar", "agri", "amasya", "ankara", "antalya",
    "artvin", "aydin", "balikesir", "bilecik", "bingol", "bitlis", "bolu",
    "burdur", "bursa", "canakkale", "cankiri", "corum", "denizli", "diyarbakir",
    "edirne", "elazig", "erzincan", "erzurum", "eskisehir", "gaziantep", "giresun",
    "gumushane", "hakkari", "hatay", "isparta", "mersin", "istanbul", "izmir",
    "kars", "kastamonu", "kayseri", "kirklareli", "kirsehir", "kocaeli", "konya",
    "kutahya", "malatya", "manisa", "kahramanmaras", "mardin", "mugla", "mus",
    "nevsehir", "nigde", "ordu", "rize", "sakarya", "samsun", "siirt", "sinop",
    "sivas", "tekirdag", "tokat", "trabzon", "tunceli", "sanliurfa", "usak",
    "van", "yozgat", "zonguldak", "aksaray", "bayburt", "karaman", "kirikkale",
    "batman", "sirnak", "bartin", "ardahan", "igdir", "yalova", "karabuk",
    "kilis", "osmaniye", "duzce",
}

_PROVINCE_DISPLAY = {
    "istanbul": "İstanbul",
    "izmir": "İzmir",
    "ankara": "Ankara",
    "bursa": "Bursa",
    "antalya": "Antalya",
    "adana": "Adana",
    "konya": "Konya",
    "gaziantep": "Gaziantep",
    "kayseri": "Kayseri",
    "mersin": "Mersin",
    "eskisehir": "Eskişehir",
    "diyarbakir": "Diyarbakır",
    "sanliurfa": "Şanlıurfa",
    "kahramanmaras": "Kahramanmaraş",
    "trabzon": "Trabzon",
    "samsun": "Samsun",
    "denizli": "Denizli",
    "malatya": "Malatya",
    "erzurum": "Erzurum",
    "van": "Van",
    "mugla": "Muğla",
    "tekirdag": "Tekirdağ",
    "sakarya": "Sakarya",
    "kocaeli": "Kocaeli",
    "hatay": "Hatay",
    "balikesir": "Balıkesir",
    "manisa": "Manisa",
    "aydin": "Aydın",
    "canakkale": "Çanakkale",
    "nevsehir": "Nevşehir",
    "rize": "Rize",
    "ordu": "Ordu",
    "giresun": "Giresun",
    "afyonkarahisar": "Afyonkarahisar",
    "isparta": "Isparta",
    "burdur": "Burdur",
    "usak": "Uşak",
    "kirklareli": "Kırklareli",
    "edirne": "Edirne",
    "corum": "Çorum",
    "tokat": "Tokat",
    "sivas": "Sivas",
    "yozgat": "Yozgat",
    "aksaray": "Aksaray",
    "karaman": "Karaman",
    "nigde": "Niğde",
    "kirsehir": "Kırşehir",
    "kutahya": "Kütahya",
    "bilecik": "Bilecik",
    "bolu": "Bolu",
    "duzce": "Düzce",
    "karabuk": "Karabük",
    "bartin": "Bartın",
    "zonguldak": "Zonguldak",
    "sinop": "Sinop",
    "kastamonu": "Kastamonu",
    "cankiri": "Çankırı",
    "amasya": "Amasya",
    "artvin": "Artvin",
    "ardahan": "Ardahan",
    "kars": "Kars",
    "igdir": "Iğdır",
    "agri": "Ağrı",
    "erzincan": "Erzincan",
    "gumushane": "Gümüşhane",
    "bayburt": "Bayburt",
    "tunceli": "Tunceli",
    "bingol": "Bingöl",
    "elazig": "Elazığ",
    "mus": "Muş",
    "bitlis": "Bitlis",
    "siirt": "Siirt",
    "sirnak": "Şırnak",
    "hakkari": "Hakkari",
    "mardin": "Mardin",
    "batman": "Batman",
    "kilis": "Kilis",
    "osmaniye": "Osmaniye",
    "adıyaman": "Adıyaman",
    "adiyaman": "Adıyaman",
    "yalova": "Yalova",
    "kirikkale": "Kırıkkale",
}

# Category keyword table (folded Turkish -> canonical category).
_CATEGORY_KEYWORDS: List[Tuple[str, Tuple[str, ...]]] = [
    ("vegan", ("vegan", "vejetaryen", "vejeteryan", "plant based")),
    ("restaurant", ("restoran", "restaurant", "lokanta", "yemek yiyebilecegim", "kebap", "pizza", "burger", "doner", "yemek")),
    ("cafe", ("kafe", "cafe", "kahve", "kahveci")),
    ("bakery", ("firin", "pastane", "bakery")),
    ("bar", ("bar ", "meyhane", "pub ")),
    ("hospital", ("hastane", "acil servis", "acil ")),
    ("pharmacy", ("eczane", "eczaneler")),
    ("hair_salon", ("berber", "kuafor", "kuafor salonu", "sac kesim", "sac kestirme", "hair salon", "barber", "guzellik salonu")),
    ("dentist", ("disc", "dis hekimi", "dis klinigi", "dental")),
    ("doctor", ("doktor", "klinik")),
    ("shopping_mall", ("avm", "alisveris merkezi", "shopping mall")),
    ("supermarket", ("supermarket", "market", "migros", "bim", "a101", "sok market")),
    ("hotel", ("otel", "hotel", "konaklama")),
    ("tourist_attraction", ("gezilecek", "turistik", "gorulmeye deger", "gezi noktasi")),
    ("museum", ("muze", "museum")),
    ("park", ("park", "yesil alan")),
    ("cinema", ("sinema", "cinema")),
    ("gym", ("spor salonu", "gym", "fitness")),
    ("atm", ("atm", "bankamatik")),
    ("bank", ("banka", "bankalar")),
    ("gas_station", ("benzin", "akaryakit", "yakit istasyonu")),
    ("parking", ("otopark", "park yeri")),
    ("transit_station", ("otobus duragi", "metro istasyonu", "durak", "toplu tasima")),
    ("police", ("polis", "karakol")),
    ("post_office", ("postane", "ptt")),
]


def detect_category(message_folded: str) -> Optional[str]:
    for category, keywords in _CATEGORY_KEYWORDS:
        for keyword in keywords:
            if keyword.strip() and keyword in message_folded:
                return category
    return None


def detect_cities(message: str) -> List[Dict[str, Any]]:
    """Ordered list of Turkish provinces named in the message."""
    folded = fold_tr(message)
    found: List[Tuple[int, str]] = []
    for province in _PROVINCES_FOLDED:
        for match in re.finditer(rf"(?<![a-z0-9]){re.escape(province)}(?![a-z0-9])", folded):
            found.append((match.start(), province))
            break
    found.sort(key=lambda item: item[0])
    return [
        {
            "key": province,
            "name": _PROVINCE_DISPLAY.get(province, province.title()),
            "index": index,
        }
        for index, province in found
    ]


def detect_city(message: str) -> Optional[str]:
    """Returns the first Turkish province named in the message."""
    cities = detect_cities(message)
    return cities[0]["name"] if cities else None


def _route_city_roles(message: str, cities: List[Dict[str, Any]]) -> Tuple[Optional[str], Optional[str]]:
    """Infers origin/destination cities from Turkish suffix patterns."""
    if not cities:
        return None, None
    if len(cities) >= 2:
        return cities[0]["name"], cities[-1]["name"]

    city = cities[0]
    folded = fold_tr(message)
    start = city["index"]
    tail = folded[start + len(city["key"]): start + len(city["key"]) + 8]
    # "İstanbul'dan", "Ankara'dan" -> origin
    if re.match(r"^\s*'?(dan|den|tan|ten)\b", tail):
        return city["name"], None
    # "Ankara'ya", "İzmir'e" -> destination
    if re.match(r"^\s*'?(ya|ye)\b", tail) or re.match(r"^\s+'?(a|e)\b", tail):
        return None, city["name"]
    return None, city["name"]


def detect_weather_scope(message_folded: str) -> str:
    if any(word in message_folded for word in ("obur gun", "ertesi gun", "pasartesi")):
        return "day_after"
    if any(word in message_folded for word in (" yarin", "yarin ", "yarina")):
        return "tomorrow"
    if any(word in message_folded for word in ("bu hafta", "haftalik", "7 gunluk", "bes gunluk", "5 gunluk")):
        return "week"
    return "today"


def detect_ranking(message_folded: str) -> str:
    if any(word in message_folded for word in ("en yakin", "en yakinindaki", "mesafe olarak", "en yakinlar")):
        return "nearest"
    if any(
        word in message_folded
        for word in ("en iyi", "en yuksek puan", "puani yuksek", "en cok begenilen", "en populer", "iyi puan")
    ):
        return "top_rated"
    return "recommended"


_WEATHER_PATTERNS = (
    "hava durumu",
    "hava nasil",
    "hava kac derece",
    "kac derece",
    "sicaklik",
    "yagmur yag",
    "yagacak mi",
    "kar yag",
    "ruzgar",
    "nem orani",
    "hava tahmini",
    "gunesli mi",
    "bulutlu mu",
)

_PLACE_PATTERNS = (
    "yakinda",
    "yakinimda",
    "en yakin",
    "civarinda",
    "civarda",
    "etrafinda",
    "etrafli",
    "nerede bulurum",
    "nerede var",
    "onerebilir",
    "oneri",
    "bulur musun",
    "goster",
)

_ROUTE_PATTERNS = (
    "yol tarifi",
    "nasil giderim",
    "nasil gidilir",
    "nasil ulasirim",
    "kac km",
    "kac dakika",
    "rota",
    "guzergah",
    "yol goster",
)

_WHERE_PATTERNS = (
    "neredeyim",
    "hangi sehirdeyim",
    "konumum nerede",
    "konumumu soyle",
    "konumum ne",
    "bulundugum yer",
)


def detect_intent(message: str) -> Dict[str, Any]:
    """Rule-based Turkish intent detection. Returns a plain dict."""
    folded = fold_tr(message)
    has_weather = any(p in folded for p in _WEATHER_PATTERNS) or (
        "hava" in folded
        and any(t in folded for t in ("bugun", "yarin", "simdi", "su an", "bu hafta", "derece"))
        and "havaliman" not in folded
        and "havaalan" not in folded
    )
    category = detect_category(folded)
    has_route = any(p in folded for p in _ROUTE_PATTERNS)
    has_where = any(p in folded for p in _WHERE_PATTERNS)
    has_place = category is not None and (
        any(p in folded for p in _PLACE_PATTERNS)
        or any(t in folded for t in ("nerede", "bul", "ara", "oneri", "goster"))
    )
    if not has_place and any(p in folded for p in ("yakinimda", "civarinda", "en yakin", "etrafimda")):
        has_place = category is not None

    if has_where:
        intent = "where_am_i"
    elif has_route:
        intent = "route"
    elif has_weather:
        intent = "weather"
    elif has_place:
        intent = "places"
    else:
        intent = "none"

    cities = detect_cities(message)
    route_origin_city, route_destination_city = (None, None)
    explicit_destination = None
    if intent == "route":
        route_origin_city, route_destination_city = _route_city_roles(message, cities)
        explicit_destination = route_destination_city or _extract_route_destination(message)

    return {
        "intent": intent,
        "category": category,
        "scope": detect_weather_scope(folded),
        "ranking": detect_ranking(folded),
        "city": cities[0]["name"] if cities else None,
        "cities": [c["name"] for c in cities],
        "route_origin_city": route_origin_city,
        "route_destination_city": route_destination_city,
        "explicit_route_destination": explicit_destination,
    }


def _extract_route_destination(message: str) -> Optional[str]:
    """Extracts 'X'e nasıl giderim' style destinations without heavy NLP."""
    text = (message or "").strip()
    patterns = [
        r"(?:buradan|burdan)?\s*([A-Za-zÇĞİÖŞÜçğıöşü0-9\s\.\-']{2,80}?)\s*(?:'?[aey]|ya|ye|'ya|'ye|'a|'e)?\s+nas[ıi]l\s+gid",
        r"([A-Za-zÇĞİÖŞÜçğıöşü0-9\s\.\-']{2,80}?)\s+(?:yol tarifi|rota|güzergah)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            candidate = " ".join(match.group(1).split()).strip(" .,'-")
            if candidate and fold_tr(candidate) not in {"buradan", "burdan", "bana", "bize"}:
                return candidate[:80]
    return None


# ------------------------------------------------------------
# Block builders (always validated before returning)
# ------------------------------------------------------------

def _safe_block(raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    block, _errors = validate_smart_ui_block(raw)
    return block


def _place_block(result: Dict[str, Any], ranking: str, location_label: str) -> Optional[Dict[str, Any]]:
    places = list(result.get("places") or [])[:8]
    if not places:
        return None
    nearest_id = result.get("nearest_id")
    top_id = result.get("top_rated_id")
    best_id = result.get("best_match_id")

    def _item(place: Dict[str, Any], badge: Optional[str] = None) -> Dict[str, Any]:
        return {
            "id": place.get("id"),
            "name": place.get("name"),
            "address": place.get("address"),
            "rating": place.get("rating"),
            "review_count": place.get("review_count"),
            "distance_km": place.get("distance_km"),
            "price_level": place.get("price_level"),
            "category_label": place.get("category_label") or result.get("category_label"),
            "latitude": place.get("latitude"),
            "longitude": place.get("longitude"),
            "google_maps_url": place.get("google_maps_url"),
            "website": place.get("website"),
            "phone": place.get("phone"),
            "badge": badge,
        }

    items: List[Dict[str, Any]] = []
    for place in places:
        badge = None
        if ranking == "nearest" and place.get("id") == nearest_id:
            badge = "En yakın"
        elif ranking == "top_rated" and place.get("id") == top_id:
            badge = "En yüksek puan"
        elif ranking == "recommended" and place.get("id") == best_id:
            badge = "Önerilen"
        items.append(_item(place, badge))

    nearest_items = [_item(p, "En yakın") for p in list(result.get("nearest") or [])[:8]]
    top_items = [_item(p, "En yüksek puan") for p in list(result.get("top_rated") or [])[:8]]

    return _safe_block(
        {
            "type": "location_results",
            "title": f"{result.get('category_label') or 'Yakın mekânlar'} — {location_label}",
            "description": result.get("ranking_explanation") or "Mesafe ve puan ayrı gösterilir.",
            "data": {
                "category": result.get("category") or "text_search",
                "category_label": result.get("category_label") or "Mekânlar",
                "location_label": location_label,
                "radius_m": result.get("radius_m"),
                "source": result.get("source"),
                "fetched_at": result.get("fetched_at"),
                "places": items,
                "nearest": nearest_items,
                "top_rated": top_items,
                "nearest_id": nearest_id,
                "top_rated_id": top_id,
                "best_match_id": best_id,
                "ranking_explanation": result.get("ranking_explanation"),
                "notice": result.get("notice"),
            },
        }
    )


def _hourly_for_scope(
    weather: Dict[str, Any],
    scope: str,
    target: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Returns hourly entries that belong to the requested day.

    Providers return a rolling window starting at "now", so blindly
    taking the first eight entries would show today's hours under a
    "tomorrow" title. Day-scoped requests are filtered by the target
    date; an empty list is the honest answer when no data exists.
    """
    hourly = list(weather.get("hourly") or [])
    if scope in {"today", "tomorrow", "day_after"}:
        target_date = str((target or {}).get("date") or "")[:10]
        if target_date:
            return [h for h in hourly if str(h.get("time") or "")[:10] == target_date][:8]
        return []
    return hourly[:8]


def _weather_block(weather: Dict[str, Any], scope: str) -> Optional[Dict[str, Any]]:
    current = weather.get("current") or {}
    daily = list(weather.get("daily") or [])[:7]
    if not daily and not current:
        return None
    target = select_target_day(weather, scope) if scope in {"today", "tomorrow", "day_after"} else None
    hourly = _hourly_for_scope(weather, scope, target)
    data: Dict[str, Any] = {
        "location_label": weather.get("location_label") or "Seçilen konum",
        "timezone": weather.get("timezone"),
        "scope": scope if scope in {"current", "today", "tomorrow", "day_after", "week"} else "week",
        "current": {
            "time": current.get("time"),
            "temperature": current.get("temperature"),
            "apparent_temperature": current.get("apparent_temperature"),
            "humidity": current.get("humidity"),
            "precipitation": current.get("precipitation"),
            "precipitation_probability": current.get("precipitation_probability"),
            "wind_speed": current.get("wind_speed"),
            "condition": current.get("condition"),
            "icon": current.get("icon"),
        }
        if current
        else None,
        "hourly": hourly,
        "daily": daily,
        "source": weather.get("source") or "Open-Meteo",
        "source_license": weather.get("source_license"),
        "fetched_at": weather.get("fetched_at"),
        "stale": bool(weather.get("stale")),
        "warning": weather.get("warning"),
    }
    title_suffix = {
        "today": "bugün",
        "tomorrow": "yarın",
        "day_after": "öbür gün",
        "week": "7 günlük",
    }.get(scope, "şu an")
    return _safe_block(
        {
            "type": "weather_forecast",
            "title": f"Hava durumu — {data['location_label']} ({title_suffix})",
            "description": (
                f"Kaynak: {data['source']} · Alınma: {data['fetched_at'] or 'bilinmiyor'}"
                + (" · Önbellek verisi (güncel değil)" if data["stale"] else "")
                + (" · Anlık koşullar ve tahmin ayrı gösterilir." if not data["stale"] else "")
            ),
            "data": data,
        }
    )


def _route_block(route: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    origin = route.get("origin") or {}
    destination = route.get("destination") or {}
    origin_point = None
    destination_point = None
    try:
        if origin:
            origin_point = Coordinates(float(origin.get("latitude")), float(origin.get("longitude"))).rounded(3)
            origin_point = origin_point.as_dict(3)
    except (TypeError, ValueError):
        origin_point = None
    try:
        if destination:
            destination_point = Coordinates(
                float(destination.get("latitude")), float(destination.get("longitude"))
            ).rounded(3)
            destination_point = destination_point.as_dict(3)
    except (TypeError, ValueError):
        destination_point = None

    return _safe_block(
        {
            "type": "route_info",
            "title": f"Yol tarifi — {route.get('origin_label')} → {route.get('destination_label')}",
            "description": f"Kaynak: {route.get('source')} · Alınma: {route.get('fetched_at')}",
            "data": {
                "origin_label": route.get("origin_label"),
                "destination_label": route.get("destination_label"),
                "travel_mode": route.get("travel_mode"),
                "travel_mode_label": route.get("travel_mode_label"),
                "distance_km": route.get("distance_km"),
                "duration_minutes": route.get("duration_minutes"),
                "direct_distance_km": route.get("direct_distance_km"),
                "steps": list(route.get("steps") or [])[:30],
                "origin": origin_point,
                "destination": destination_point,
                "encoded_polyline": route.get("polyline"),
                "google_maps_url": route.get("google_maps_url"),
                "source": route.get("source"),
                "fetched_at": route.get("fetched_at"),
            },
        }
    )


def _location_request_block(pref: Dict[str, Any], reason: str, city: Optional[str]) -> Optional[Dict[str, Any]]:
    state = pref.get("permission") or STATE_UNSET
    allow_device = state not in {STATE_DENIED, STATE_OFF}
    suggested = [city] if city else []
    manual = pref.get("manual_city")
    if manual and manual not in suggested:
        suggested.append(manual)
    for fallback in ("İstanbul", "Ankara", "İzmir", "Bursa"):
        if fallback not in suggested:
            suggested.append(fallback)
    return _safe_block(
        {
            "type": "location_request",
            "title": "Konumunu paylaş",
            "description": (
                "Cihaz konumun yalnızca açık izinle ve bu istek için kullanılır. "
                "İstersen cihaz konumu yerine bir şehir seçebilirsin."
            ),
            "data": {
                "reason": reason[:240],
                "permission_state": state if state in {"unset", "granted", "denied", "manual", "off"} else "unset",
                "allow_device": allow_device,
                "suggested_cities": suggested[:6],
            },
        }
    )


def _location_info_block(
    label: str,
    coords: Coordinates,
    *,
    source: str,
    permission: str,
    note: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    safe = coords.rounded(3)
    return _safe_block(
        {
            "type": "location_info",
            "title": "Konum bilgisi",
            "description": note,
            "data": {
                "label": label,
                "latitude": safe.latitude,
                "longitude": safe.longitude,
                "source": source if source in {"device", "manual_city", "place"} else "manual_city",
                "precision_meters": 110 if source != "manual_city" else 1100,
                "permission": permission,
                "note": note,
            },
        }
    )


# ------------------------------------------------------------
# Context text builders
# ------------------------------------------------------------

def _fmt_place_line(index: int, place: Dict[str, Any]) -> str:
    rating = place.get("rating")
    reviews = place.get("review_count")
    distance = place.get("distance_km")
    rating_text = f"{rating:.1f}/5" if isinstance(rating, (int, float)) else "puan yok"
    review_text = f"{reviews} yorum" if reviews is not None else "yorum sayısı yok"
    distance_text = f"{distance:.2f} km" if isinstance(distance, (int, float)) else "mesafe bilinmiyor"
    return (
        f"{index}. {place.get('name')} — {rating_text} ({review_text}), {distance_text} — "
        f"{place.get('address')}"
    )


def _places_context(result: Dict[str, Any], location_label: str, ranking: str) -> str:
    lines = [
        f"CANLI MEKÂN VERİSİ (kaynak: {result.get('source')}, alınma: {result.get('fetched_at')}):",
        f"Konum: {location_label} · Kategori: {result.get('category_label')} · "
        f"Yarıçap: {(result.get('radius_m') or 0)} m",
        f"İstenen sıralama: {ranking}. {result.get('ranking_explanation')}",
    ]
    nearest = list(result.get("nearest") or [])[:5]
    top_rated = list(result.get("top_rated") or [])[:5]
    recommended = list(result.get("places") or [])[:5]
    if nearest:
        lines.append("En yakın (yalnızca mesafeye göre):")
        lines.extend(_fmt_place_line(i + 1, p) for i, p in enumerate(nearest))
    if top_rated:
        lines.append("En yüksek puanlı (puan ve yorum sayısına göre):")
        lines.extend(_fmt_place_line(i + 1, p) for i, p in enumerate(top_rated))
    if recommended:
        lines.append("Önerilen (puan + yakınlık):")
        lines.extend(_fmt_place_line(i + 1, p) for i, p in enumerate(recommended))
    if result.get("notice"):
        lines.append(f"Not: {result['notice']}")
    lines.append(
        "Bu veriler gerçek sağlayıcıdan geldi. Listede olmayan işletme, adres, puan veya mesafe UYDURMA. "
        "Puanı ve mesafeyi ayrı ayrı, kendi etiketiyle sun."
    )
    return "\n".join(lines)


def _weather_context(weather: Dict[str, Any], scope: str, location_label: str) -> str:
    current = weather.get("current") or {}
    target = select_target_day(weather, scope) if scope in {"today", "tomorrow", "day_after"} else None
    lines = [
        f"HAVA DURUMU (kaynak: {weather.get('source')}, alınma: {weather.get('fetched_at')}, "
        f"saat dilimi: {weather.get('timezone')}):",
        f"Konum: {location_label}",
        "Aşağıdaki iki bölümü karıştırma: 'anlık koşullar' şu anki ölçüm, 'tahmin' ise gelecek için model çıktısıdır.",
    ]
    if current:
        lines.append(
            "Anlık koşullar (şu an): {temp}°C (hissedilen {feels}°C), {cond}, nem %{hum}, rüzgar {wind} km/sa, "
            "yağış olasılığı %{pop}.".format(
                temp=current.get("temperature"),
                feels=current.get("apparent_temperature"),
                cond=current.get("condition"),
                hum=current.get("humidity"),
                wind=current.get("wind_speed"),
                pop=current.get("precipitation_probability"),
            )
        )
    if target:
        lines.append(
            "Tahmin (hedef gün {date}, {weekday}): {cond}, en yüksek {tmax}°C, en düşük {tmin}°C, "
            "yağış olasılığı %{pop}, yağış {rain} mm, UV {uv}.".format(
                date=target.get("date"),
                weekday=target.get("weekday") or "",
                cond=target.get("condition"),
                tmax=target.get("temp_max"),
                tmin=target.get("temp_min"),
                pop=target.get("precipitation_probability"),
                rain=target.get("precipitation_sum"),
                uv=target.get("uv_index"),
            )
        )
    daily_rows = list(weather.get("daily") or [])[:7]
    if daily_rows:
        lines.append("Tahmin (günlük):")
    for day in daily_rows:
        lines.append(
            f"- {day.get('date')} ({day.get('weekday')}): {day.get('condition')}, "
            f"{day.get('temp_min')}–{day.get('temp_max')}°C, yağış %{day.get('precipitation_probability')}"
        )
    if weather.get("stale"):
        lines.append(
            f"UYARI: Bu veri canlı değil, önbellekten geldi. {weather.get('warning') or ''} "
            "Kullanıcıya güncelmiş gibi sunma."
        )
    elif weather.get("warning"):
        lines.append(f"UYARI: {weather['warning']}")
    lines.append(
        "Sıcaklık, koşul veya yağış UYDURMA. Yalnızca yukarıdaki sayıları kullan ve kaynağı belirt."
    )
    return "\n".join(lines)


def _route_context(route: Dict[str, Any]) -> str:
    lines = [
        f"CANLI YOL TARİFİ (kaynak: {route.get('source')}, alınma: {route.get('fetched_at')}):",
        f"Başlangıç: {route.get('origin_label')} · Hedef: {route.get('destination_label')}",
        f"Mod: {route.get('travel_mode_label')} · Mesafe: {route.get('distance_km')} km · "
        f"Süre: {route.get('duration_minutes')} dakika",
    ]
    for index, step in enumerate(list(route.get("steps") or [])[:15]):
        lines.append(
            f"{index + 1}. {step.get('instruction')} "
            f"({step.get('distance_m')} m, {step.get('duration_seconds')} sn)"
        )
    lines.append(
        "Süre ve mesafeyi UYDURMA. Trafik durumuna göre sürenin değişebileceğini belirt."
    )
    return "\n".join(lines)


class LocationIntelligenceError(Exception):
    def __init__(self, message: str, *, code: str = "location_intelligence_error"):
        super().__init__(message)
        self.public_message = message
        self.code = code


# ------------------------------------------------------------
# Orchestration
# ------------------------------------------------------------

def _resolve_origin(
    intent_data: Dict[str, Any],
    profile: Dict[str, Any],
    req_location: Any,
) -> Dict[str, Any]:
    pref = public_preference(profile.get("location_preference") if isinstance(profile, dict) else None)
    # 1) Explicit city in the message always wins as the origin, except for
    #    route requests where the named city may be the destination.
    city = intent_data.get("city")
    if intent_data.get("intent") == "route":
        city = intent_data.get("route_origin_city")
        if not city and intent_data.get("route_destination_city"):
            city = None
    if city:
        try:
            candidates = geocode_place(city, limit=3)
            if candidates:
                candidate = candidates[0]
                return {
                    "coords": validate_coordinates(candidate.latitude, candidate.longitude, decimals=4),
                    "label": candidate.label(),
                    "source": "explicit_city",
                    "explanation": f"Kullanıcı açıkça {candidate.label()} dedi.",
                }
        except LocationServiceError as exc:
            return {
                "coords": None,
                "label": city,
                "source": "error",
                "explanation": exc.public_message,
            }
    # 2) Consented device fix (never stored).
    resolved = resolve_request_origin(req_location, profile.get("location_preference") or {})
    if resolved.get("coords"):
        return resolved
    # 3) Remembered manual city.
    pref_dict = profile.get("location_preference") or {}
    manual = preference_coordinates(pref_dict) if isinstance(pref_dict, dict) else None
    if manual and pref_dict.get("manual_city"):
        return {
            "coords": manual,
            "label": pref_dict.get("manual_city"),
            "source": "manual_city",
            "explanation": "Manuel şehir tercihi kullanılıyor.",
        }
    return resolved


def handle_location_request(
    message: str,
    *,
    user_uid: str,
    is_guest: bool,
    profile: Optional[Dict[str, Any]],
    req_location: Any = None,
    allow_network: bool = True,
) -> Dict[str, Any]:
    """Main entry point for chat integration.

    Returns:
        {
          "handled": bool,
          "intent": str,
          "context_text": str | None,
          "blocks": list[dict],
          "error": dict | None,
          "meta": dict,
        }
    """
    profile = profile if isinstance(profile, dict) else {}
    intent_data = detect_intent(message)
    intent = intent_data["intent"]
    result: Dict[str, Any] = {
        "handled": intent != "none",
        "intent": intent,
        "context_text": None,
        "blocks": [],
        "error": None,
        "meta": {
            "category": intent_data.get("category"),
            "scope": intent_data.get("scope"),
            "ranking": intent_data.get("ranking"),
            "city": intent_data.get("city"),
        },
    }
    if intent == "none":
        return result

    pref_raw = profile.get("location_preference") or {}
    pref = public_preference(pref_raw)
    blocks: List[Dict[str, Any]] = []

    if not allow_network:
        result["context_text"] = (
            "Konum/hava/yol tarifi özelliği bu çalışma modunda canlı sağlayıcıya bağlanamıyor. "
            "Kullanıcıya veri uydurmadan, özelliğin sunucu ve API anahtarı gerektirdiğini açıkça söyle."
        )
        result["error"] = {"code": "network_disabled", "message": "Canlı konum sağlayıcısı devre dışı."}
        return result

    try:
        usage_guard.check(user_uid, is_guest=is_guest)
    except LocationServiceError as exc:
        result["error"] = exc.to_dict()
        result["context_text"] = (
            f"Konum isteği sınırlandı: {exc.public_message} Kullanıcıya bu mesajı aynen aktar; veri uydurma."
        )
        return result

    origin = _resolve_origin(intent_data, profile, req_location)

    try:
        if intent == "where_am_i":
            if origin.get("coords"):
                coords = origin["coords"]
                label = origin.get("label") or "Mevcut konumun"
                if origin.get("source") == "device":
                    resolved = reverse_geocode(coords)
                    if resolved:
                        label = resolved.get("label") or label
                        provider_label = {
                            "osm_nominatim": "OpenStreetMap Nominatim",
                            "google_geocoding": "Google Geocoding",
                        }.get(resolved.get("provider") or "", "ters geocoding sağlayıcısı")
                        result["context_text"] = (
                            f"CANLI KONUM BİLGİSİ (kaynak: {provider_label}, alınma: {utc_now_iso()}):\n"
                            f"Kullanıcı şu anda {label} civarında. Koordinatlar yalnızca bu yanıt için "
                            "kullanıldı; kalıcı olarak saklanmadı. Adresi UYDURMA."
                        )
                    else:
                        result["context_text"] = (
                            f"Kullanıcı cihaz konumunu paylaştı: {label}. "
                            "Ters geocoding şu anda adres/şehir sonucu vermedi. "
                            "Adres UYDURMA; yalnızca konumun alındığını söyle."
                        )
                else:
                    result["context_text"] = (
                        f"Kullanıcının seçili konumu: {label} "
                        f"(kaynak: {origin.get('explanation')}). Bu bilgi manuel şehir tercihinden gelir."
                    )
                block = _location_info_block(
                    label,
                    coords,
                    source="device" if origin.get("source") == "device" else "manual_city",
                    permission=pref.get("permission") or STATE_UNSET,
                    note=origin.get("explanation"),
                )
                if block:
                    blocks.append(block)
            else:
                block = _location_request_block(pref_raw, "Konumunu öğrenmek için izin veya şehir gerekli.", intent_data.get("city"))
                if block:
                    blocks.append(block)
                result["context_text"] = (
                    "Kullanıcının konumu bilinmiyor. Cihaz izni verilmedi veya şehir seçilmedi. "
                    "Konum uydurma; izin veya şehir seçmesini iste."
                )

        elif intent == "weather":
            if not origin.get("coords"):
                block = _location_request_block(
                    pref_raw,
                    "Hava durumunu göstermek için cihaz izni veya şehir seçimi gerekli.",
                    intent_data.get("city"),
                )
                if block:
                    blocks.append(block)
                result["context_text"] = (
                    "Hava durumu için konum yok. Kullanıcıya cihaz izni verebileceğini veya şehir "
                    "seçebileceğini söyle. Hava tahmini UYDURMA."
                )
            else:
                coords = origin["coords"]
                label = origin.get("label") or "Seçilen konum"
                weather = forecast(coords, label=label, days=7)
                scope = intent_data.get("scope") or "today"
                block = _weather_block(weather, scope)
                if block:
                    blocks.append(block)
                result["context_text"] = _weather_context(weather, scope, label)
                result["meta"]["source"] = weather.get("source")
                result["meta"]["fetched_at"] = weather.get("fetched_at")
                result["meta"]["stale"] = bool(weather.get("stale"))

        elif intent == "places":
            category = intent_data.get("category")
            ranking = intent_data.get("ranking") or "recommended"
            destination_text = intent_data.get("explicit_route_destination")
            if not origin.get("coords"):
                # Text search can still work without coordinates when the user
                # named something specific, but we never invent a centre.
                if not destination_text:
                    block = _location_request_block(
                        pref_raw,
                        "Yakın mekânları aramak için cihaz izni veya şehir seçimi gerekli.",
                        intent_data.get("city"),
                    )
                    if block:
                        blocks.append(block)
                    result["context_text"] = (
                        "Yakın mekân araması için konum yok. Cihaz izni veya şehir seçimi iste. "
                        "İşletme, adres veya puan UYDURMA."
                    )
                    return result
                search = search_text(destination_text, center=None, max_results=8)
                label = destination_text
            else:
                coords = origin["coords"]
                label = origin.get("label") or "Seçilen konum"
                if destination_text and not category:
                    search = search_text(destination_text, center=coords, max_results=8)
                elif category:
                    search = search_nearby(category, coords, max_results=10)
                else:
                    block = _location_request_block(
                        pref_raw, "Hangi tür mekân aradığını belirtmen gerekiyor.", intent_data.get("city")
                    )
                    if block:
                        blocks.append(block)
                    result["context_text"] = (
                        "Kullanıcı 'yakın' dedi ama kategori belirtmedi. Restoran, kafe, eczane gibi "
                        "bir tür seçmesini iste. İşletme UYDURMA."
                    )
                    return result
                block = _place_block(search, ranking, label)
                if block:
                    blocks.append(block)
                comparison = comparison_block(search)
                if comparison and len(blocks) < 3:
                    blocks.append(comparison)
                result["context_text"] = _places_context(search, label, ranking)
                result["meta"]["source"] = search.get("source")
                result["meta"]["fetched_at"] = search.get("fetched_at")

        elif intent == "route":
            if not origin.get("coords"):
                block = _location_request_block(
                    pref_raw,
                    "Yol tarifi için başlangıç konumu gerekli. Cihaz izni veya şehir seç.",
                    intent_data.get("city"),
                )
                if block:
                    blocks.append(block)
                result["context_text"] = (
                    "Yol tarifi için başlangıç konumu yok. Cihaz izni veya şehir seçimi iste. "
                    "Mesafe veya süre UYDURMA."
                )
            else:
                start = origin["coords"]
                start_label = origin.get("label") or "Başlangıç"
                destination_text = intent_data.get("explicit_route_destination")
                if not destination_text:
                    block = _location_request_block(
                        pref_raw, "Yol tarifi için hedef belirtilmedi.", intent_data.get("city")
                    )
                    if block:
                        blocks.append(block)
                    result["context_text"] = (
                        "Hedef belirtilmedi. Kullanıcıdan bir yer adı veya adres istemesini söyle. "
                        "Rota UYDURMA."
                    )
                    return result
                found = search_text(destination_text, center=start, max_results=3)
                places = list(found.get("places") or [])
                if not places:
                    raise LocationServiceError(
                        f"'{destination_text}' için hedef bulunamadı. Lütfen daha net bir yer adı dene.",
                        code="destination_not_found",
                    )
                target = places[0]
                destination = validate_coordinates(target.get("latitude"), target.get("longitude"), decimals=4)
                route = compute_route(
                    start,
                    destination,
                    travel_mode="DRIVE",
                    destination_label=target.get("name") or destination_text,
                    origin_label=start_label,
                )
                block = _route_block(route)
                if block:
                    blocks.append(block)
                result["context_text"] = _route_context(route)
                result["meta"]["source"] = route.get("source")
                result["meta"]["fetched_at"] = route.get("fetched_at")

    except LocationServiceError as exc:
        result["error"] = exc.to_dict()
        result["context_text"] = (
            f"Canlı konum/hava verisi alınamadı: {exc.public_message} "
            "Kullanıcıya bu sınırlamayı açıkça söyle; eksik veriyi tahminle doldurma."
        )
    except Exception:
        # Never leak provider URLs or coordinates into the response.
        result["error"] = {
            "code": "location_internal_error",
            "message": "Konum servisi beklenmeyen bir hata verdi. Lütfen tekrar dene.",
        }
        result["context_text"] = (
            "Konum servisi beklenmeyen bir hata verdi. Kullanıcıya tekrar denemesini söyle; "
            "veri UYDURMA."
        )

    result["blocks"] = blocks[:3]
    return result


def location_capabilities() -> Dict[str, Any]:
    return {
        "intents": ["weather", "places", "route", "where_am_i"],
        "categories": {key: CATEGORY_LABELS_TR[key] for key in CATEGORY_LABELS_TR},
        "scopes": ["today", "tomorrow", "day_after", "week"],
        "rankings": ["nearest", "top_rated", "recommended"],
        "default_radius_m": {key: default_radius_m(key) for key in CATEGORY_LABELS_TR},
    }
