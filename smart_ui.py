# ============================================================
# LUMINA AI - SMART UI ENGINE (KATI ŞEMA & GÜVENLİK MODELİ)
# Güvenli, kum havuzlu ve etkileşimli arayüz bileşen kaydı.
#
# TASARIM İLKELERİ:
#   - AI yalnızca JSON üretir; HTML/JavaScript ASLA üretmez.
#   - Her bileşen tipinin kendi katı Pydantic şeması vardır.
#   - Bilinmeyen tip, fazla alan veya sınır aşımı reddedilir.
#   - Tüm metinler sunucu tarafında normalize edilir ve temizlenir.
#   - Frontend ikinci savunma hattı olarak textContent kullanır.
# ============================================================

import re
import json
from typing import Dict, Any, List, Optional, Literal, Tuple, Type

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
    AliasChoices,
)

# ============================================================
# SINIRLAR
# ============================================================

MAX_BLOCKS_PER_REPLY = 3
MAX_RAW_BLOCK_CHARS = 16_000
MAX_TOTAL_BLOCKS_BYTES = 48_000
MAX_STRING_LEN = 1_000
MAX_LIST_ITEMS = 100

SUPPORTED_UI_TYPES = {
    "calculator",
    "task_manager",
    "budget_planner",
    "calendar",
    "unit_converter",
    "project_roadmap",
    "study_planner",
    "comparison_table",
    "interactive_form",
    "checklist",
    "progress_tracker",
    "data_table",
    # Location / weather / route blocks. These are built by the backend
    # from live provider data and are therefore server-only: the model is
    # never allowed to invent them.
    "location_results",
    "weather_forecast",
    "route_info",
    "location_request",
    "location_info",
}

# Types the AI model may emit itself. Server-only types are excluded so a
# model can never fabricate coordinates, businesses or weather.
SERVER_ONLY_UI_TYPES = {
    "location_results",
    "weather_forecast",
    "route_info",
    "location_request",
    "location_info",
}

SMART_UI_TYPE_LABELS_TR = {
    "calculator": "Hesap Makinesi",
    "task_manager": "Görev Listesi",
    "budget_planner": "Bütçe Planlayıcı",
    "calendar": "Takvim",
    "unit_converter": "Birim Çevirici",
    "project_roadmap": "Proje Yol Haritası",
    "study_planner": "Ders Programı",
    "comparison_table": "Karşılaştırma Tablosu",
    "interactive_form": "İnteraktif Form",
    "checklist": "Kontrol Listesi",
    "progress_tracker": "İlerleme Takibi",
    "data_table": "Veri Tablosu",
    "location_results": "Yakın Mekânlar",
    "weather_forecast": "Hava Durumu",
    "route_info": "Yol Tarifi",
    "location_request": "Konum İzni",
    "location_info": "Konum Bilgisi",
}


# ============================================================
# ORTAK MODEL TABANI
# ============================================================

class StrictModel(BaseModel):
    """Fazla alanları reddeden, metinleri kırpan katı model tabanı."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        validate_assignment=True,
        populate_by_name=True,
    )


def _bounded_text(max_len: int, min_len: int = 1):
    return Field(min_length=min_len, max_length=max_len)


def _validate_iso_date(value: str) -> str:
    from datetime import date as _date

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""):
        raise ValueError("Tarih YYYY-AA-GG biçiminde olmalıdır.")
    try:
        _date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"Geçersiz tarih: {value}") from exc
    return value


def _validate_iso_time(value: str) -> str:
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value or ""):
        raise ValueError("Saat SS:DD biçiminde olmalıdır.")
    return value


# ============================================================
# BİLEŞEN ŞEMALARI
# ============================================================

class CalculatorData(StrictModel):
    initial_value: float = Field(default=0, ge=-1e15, le=1e15)
    formula: str = Field(default="", max_length=200)


class TaskItem(StrictModel):
    id: Optional[str] = Field(default=None, max_length=40)
    title: str = _bounded_text(160)
    done: bool = False
    priority: Optional[Literal["low", "medium", "high"]] = None


class TaskManagerData(StrictModel):
    tasks: List[TaskItem] = Field(default_factory=list, max_length=50)


class BudgetExpense(StrictModel):
    title: str = _bounded_text(120)
    amount: float = Field(ge=0, le=1e12)
    category: Optional[str] = Field(default=None, max_length=60)


class BudgetPlannerData(StrictModel):
    currency: str = Field(default="TL", min_length=1, max_length=8)
    income: float = Field(default=0, ge=0, le=1e12)
    expenses: List[BudgetExpense] = Field(default_factory=list, max_length=60)


class CalendarEvent(StrictModel):
    title: str = _bounded_text(160)
    date: str = _bounded_text(10)
    time: Optional[str] = Field(default=None, max_length=5)

    @field_validator("date")
    @classmethod
    def _check_date(cls, v: str) -> str:
        return _validate_iso_date(v)

    @field_validator("time")
    @classmethod
    def _check_time(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_time(v) if v else v


class CalendarData(StrictModel):
    events: List[CalendarEvent] = Field(default_factory=list, max_length=60)


class UnitConverterData(StrictModel):
    category: Literal["length", "mass", "time", "volume", "data"] = "length"
    from_unit: str = _bounded_text(40)
    to_unit: str = _bounded_text(40)
    value: float = Field(default=1, ge=-1e15, le=1e15)


class RoadmapMilestone(StrictModel):
    title: str = _bounded_text(160)
    status: Literal["planned", "in_progress", "done", "blocked"] = "planned"
    due: Optional[str] = Field(default=None, max_length=10)
    description: Optional[str] = Field(default=None, max_length=300)
    progress: Optional[int] = Field(default=None, ge=0, le=100)
    tasks: List[str] = Field(default_factory=list, max_length=12)

    @field_validator("due")
    @classmethod
    def _check_due(cls, v: Optional[str]) -> Optional[str]:
        return _validate_iso_date(v) if v else v


class ProjectRoadmapData(StrictModel):
    milestones: List[RoadmapMilestone] = Field(
        default_factory=list,
        max_length=30,
        validation_alias=AliasChoices("milestones", "phases", "steps"),
    )


class StudyScheduleItem(StrictModel):
    day: str = _bounded_text(40)
    subject: str = _bounded_text(160)
    duration: Optional[str] = Field(default=None, max_length=40)


class StudyPlannerData(StrictModel):
    schedule: List[StudyScheduleItem] = Field(default_factory=list, max_length=60)


class ComparisonTableData(StrictModel):
    headers: List[str] = Field(min_length=1, max_length=8)
    rows: List[List[str]] = Field(min_length=1, max_length=30)

    @field_validator("headers")
    @classmethod
    def _headers_ok(cls, v: List[str]) -> List[str]:
        return [str(x)[:120] for x in v]

    @model_validator(mode="after")
    def _normalize_rows(self):
        width = len(self.headers)
        normalized: List[List[str]] = []
        for row in self.rows:
            if len(row) > width:
                raise ValueError("Satır, başlık sayısından fazla hücre içeriyor.")
            cells = [str(c)[:300] for c in row]
            cells.extend([""] * (width - len(cells)))
            normalized.append(cells)
        # validate_assignment=True olduğu için normal atama model doğrulayıcısını
        # yeniden tetikler ve sonsuz özyinelemeye yol açar. Doğrulanmış değeri
        # doğrudan yazıyoruz.
        object.__setattr__(self, "rows", normalized)
        return self


class FormFieldSchema(StrictModel):
    name: str = Field(min_length=1, max_length=41)
    label: str = _bounded_text(120)
    type: Literal[
        "text", "textarea", "number", "email", "date", "select", "checkbox", "range"
    ] = "text"
    required: bool = False
    placeholder: Optional[str] = Field(default=None, max_length=120)
    default: Optional[str] = Field(default=None, max_length=300)
    min: Optional[float] = Field(default=None, ge=-1e12, le=1e12)
    max: Optional[float] = Field(default=None, ge=-1e12, le=1e12)
    options: List[str] = Field(default_factory=list, max_length=30)

    @field_validator("name")
    @classmethod
    def _safe_name(cls, v: str) -> str:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,40}", v or ""):
            raise ValueError("Alan adı yalnızca harf, rakam ve alt çizgi içerebilir.")
        return v

    @model_validator(mode="after")
    def _check_constraints(self):
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min değeri max değerinden büyük olamaz.")
        if self.type == "select" and not self.options:
            raise ValueError("select alanı en az bir seçenek içermelidir.")
        if self.type == "range" and (self.min is None or self.max is None):
            raise ValueError("range alanı min ve max değerleri gerektirir.")
        object.__setattr__(self, "options", [str(o)[:120] for o in self.options])
        return self


class InteractiveFormData(StrictModel):
    fields: List[FormFieldSchema] = Field(min_length=1, max_length=25)

    @model_validator(mode="after")
    def _unique_names(self):
        names = [f.name for f in self.fields]
        if len(names) != len(set(names)):
            raise ValueError("Form alan adları benzersiz olmalıdır.")
        return self


class ChecklistItem(StrictModel):
    text: str = _bounded_text(200)
    done: bool = False


class ChecklistData(StrictModel):
    items: List[ChecklistItem] = Field(default_factory=list, max_length=80)


class ProgressGoal(StrictModel):
    label: str = _bounded_text(160)
    current: float = Field(default=0, ge=0, le=1e12)
    target: float = Field(gt=0, le=1e12)
    unit: Optional[str] = Field(default=None, max_length=24)


class ProgressTrackerData(StrictModel):
    goals: List[ProgressGoal] = Field(min_length=1, max_length=30)


class DataTableData(StrictModel):
    columns: List[str] = Field(min_length=1, max_length=10)
    rows: List[List[str]] = Field(min_length=1, max_length=150)
    caption: Optional[str] = Field(default=None, max_length=200)

    @field_validator("columns")
    @classmethod
    def _columns_ok(cls, v: List[str]) -> List[str]:
        return [str(x)[:120] for x in v]

    @model_validator(mode="after")
    def _normalize_rows(self):
        width = len(self.columns)
        normalized: List[List[str]] = []
        for row in self.rows:
            if len(row) > width:
                raise ValueError("Satır, sütun sayısından fazla hücre içeriyor.")
            cells = [str(c)[:300] for c in row]
            cells.extend([""] * (width - len(cells)))
            normalized.append(cells)
        object.__setattr__(self, "rows", normalized)
        return self


# ------------------------------------------------------------
# LOCATION / WEATHER / ROUTE SCHEMAS
# All of these are produced by the backend from live provider
# data. The model is never allowed to generate them.
# ------------------------------------------------------------

class PlaceItem(StrictModel):
    id: Optional[str] = Field(default=None, max_length=120)
    name: str = _bounded_text(160)
    address: Optional[str] = Field(default=None, max_length=240)
    rating: Optional[float] = Field(default=None, ge=0, le=5)
    review_count: Optional[int] = Field(default=None, ge=0, le=100_000_000)
    distance_km: Optional[float] = Field(default=None, ge=0, le=20_000)
    price_level: Optional[str] = Field(default=None, max_length=40)
    category_label: Optional[str] = Field(default=None, max_length=80)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    google_maps_url: Optional[str] = Field(default=None, max_length=800)
    website: Optional[str] = Field(default=None, max_length=800)
    phone: Optional[str] = Field(default=None, max_length=40)
    badge: Optional[str] = Field(default=None, max_length=40)


class LocationResultsData(StrictModel):
    category: str = _bounded_text(60)
    category_label: str = _bounded_text(100)
    location_label: Optional[str] = Field(default=None, max_length=160)
    radius_m: Optional[int] = Field(default=None, ge=0, le=50_000)
    source: Optional[str] = Field(default=None, max_length=120)
    fetched_at: Optional[str] = Field(default=None, max_length=40)
    places: List[PlaceItem] = Field(min_length=1, max_length=10)
    nearest: List[PlaceItem] = Field(default_factory=list, max_length=10)
    top_rated: List[PlaceItem] = Field(default_factory=list, max_length=10)
    nearest_id: Optional[str] = Field(default=None, max_length=120)
    top_rated_id: Optional[str] = Field(default=None, max_length=120)
    best_match_id: Optional[str] = Field(default=None, max_length=120)
    ranking_explanation: Optional[str] = Field(default=None, max_length=500)
    notice: Optional[str] = Field(default=None, max_length=300)


class WeatherNow(StrictModel):
    time: Optional[str] = Field(default=None, max_length=32)
    temperature: Optional[float] = Field(default=None, ge=-90, le=70)
    apparent_temperature: Optional[float] = Field(default=None, ge=-90, le=70)
    humidity: Optional[float] = Field(default=None, ge=0, le=100)
    precipitation: Optional[float] = Field(default=None, ge=0, le=1000)
    precipitation_probability: Optional[float] = Field(default=None, ge=0, le=100)
    wind_speed: Optional[float] = Field(default=None, ge=0, le=1000)
    condition: Optional[str] = Field(default=None, max_length=60)
    icon: Optional[str] = Field(default=None, max_length=8)


class WeatherHour(StrictModel):
    time: str = _bounded_text(32)
    temperature: Optional[float] = Field(default=None, ge=-90, le=70)
    apparent_temperature: Optional[float] = Field(default=None, ge=-90, le=70)
    precipitation_probability: Optional[float] = Field(default=None, ge=0, le=100)
    precipitation: Optional[float] = Field(default=None, ge=0, le=1000)
    wind_speed: Optional[float] = Field(default=None, ge=0, le=1000)
    humidity: Optional[float] = Field(default=None, ge=0, le=100)
    condition: Optional[str] = Field(default=None, max_length=60)
    icon: Optional[str] = Field(default=None, max_length=8)


class WeatherDay(StrictModel):
    date: str = _bounded_text(10)
    weekday: Optional[str] = Field(default=None, max_length=20)
    condition: Optional[str] = Field(default=None, max_length=60)
    icon: Optional[str] = Field(default=None, max_length=8)
    temp_max: Optional[float] = Field(default=None, ge=-90, le=70)
    temp_min: Optional[float] = Field(default=None, ge=-90, le=70)
    apparent_max: Optional[float] = Field(default=None, ge=-90, le=70)
    apparent_min: Optional[float] = Field(default=None, ge=-90, le=70)
    precipitation_sum: Optional[float] = Field(default=None, ge=0, le=1000)
    precipitation_probability: Optional[float] = Field(default=None, ge=0, le=100)
    wind_speed_max: Optional[float] = Field(default=None, ge=0, le=1000)
    sunrise: Optional[str] = Field(default=None, max_length=10)
    sunset: Optional[str] = Field(default=None, max_length=10)
    uv_index: Optional[float] = Field(default=None, ge=0, le=30)

    @field_validator("date")
    @classmethod
    def _check_date(cls, v: str) -> str:
        return _validate_iso_date(v)


class WeatherForecastData(StrictModel):
    location_label: str = _bounded_text(160)
    timezone: Optional[str] = Field(default=None, max_length=80)
    scope: Literal["current", "today", "tomorrow", "day_after", "week"] = "current"
    current: Optional[WeatherNow] = None
    hourly: List[WeatherHour] = Field(default_factory=list, max_length=24)
    daily: List[WeatherDay] = Field(default_factory=list, max_length=7)
    source: str = _bounded_text(120)
    source_license: Optional[str] = Field(default=None, max_length=80)
    fetched_at: Optional[str] = Field(default=None, max_length=40)
    stale: bool = False
    warning: Optional[str] = Field(default=None, max_length=300)


class RouteStep(StrictModel):
    instruction: str = _bounded_text(240)
    distance_m: Optional[int] = Field(default=None, ge=0, le=5_000_000)
    duration_seconds: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    travel_mode: Optional[str] = Field(default=None, max_length=20)


class RoutePoint(StrictModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)

    @model_validator(mode="after")
    def _round_public_coordinates(self):
        # Route map blocks never need device-grade precision.
        object.__setattr__(self, "latitude", round(float(self.latitude), 3))
        object.__setattr__(self, "longitude", round(float(self.longitude), 3))
        return self


class RouteInfoData(StrictModel):
    origin_label: str = _bounded_text(160)
    destination_label: str = _bounded_text(160)
    travel_mode: Optional[str] = Field(default=None, max_length=20)
    travel_mode_label: Optional[str] = Field(default=None, max_length=40)
    distance_km: Optional[float] = Field(default=None, ge=0, le=5_000)
    duration_minutes: Optional[float] = Field(default=None, ge=0, le=100_000)
    direct_distance_km: Optional[float] = Field(default=None, ge=0, le=5_000)
    steps: List[RouteStep] = Field(default_factory=list, max_length=30)
    origin: Optional[RoutePoint] = None
    destination: Optional[RoutePoint] = None
    encoded_polyline: Optional[str] = Field(default=None, max_length=6000)
    google_maps_url: Optional[str] = Field(default=None, max_length=800)
    source: Optional[str] = Field(default=None, max_length=120)
    fetched_at: Optional[str] = Field(default=None, max_length=40)


class LocationRequestData(StrictModel):
    reason: str = _bounded_text(240)
    permission_state: Literal["unset", "granted", "denied", "manual", "off"] = "unset"
    allow_device: bool = True
    suggested_cities: List[str] = Field(default_factory=list, max_length=6)


class LocationInfoData(StrictModel):
    label: str = _bounded_text(160)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    source: Literal["device", "manual_city", "place"] = "manual_city"
    precision_meters: Optional[int] = Field(default=None, ge=0, le=50_000)
    permission: Optional[str] = Field(default=None, max_length=20)
    note: Optional[str] = Field(default=None, max_length=300)

    @model_validator(mode="after")
    def _round_public_coordinates(self):
        # Public blocks never carry device-grade precision.
        object.__setattr__(self, "latitude", round(float(self.latitude), 3))
        object.__setattr__(self, "longitude", round(float(self.longitude), 3))
        return self


SCHEMA_REGISTRY: Dict[str, Type[StrictModel]] = {
    "calculator": CalculatorData,
    "task_manager": TaskManagerData,
    "budget_planner": BudgetPlannerData,
    "calendar": CalendarData,
    "unit_converter": UnitConverterData,
    "project_roadmap": ProjectRoadmapData,
    "study_planner": StudyPlannerData,
    "comparison_table": ComparisonTableData,
    "interactive_form": InteractiveFormData,
    "checklist": ChecklistData,
    "progress_tracker": ProgressTrackerData,
    "data_table": DataTableData,
    "location_results": LocationResultsData,
    "weather_forecast": WeatherForecastData,
    "route_info": RouteInfoData,
    "location_request": LocationRequestData,
    "location_info": LocationInfoData,
}


class SmartUIEnvelope(StrictModel):
    type: str = Field(min_length=1, max_length=40)
    title: str = Field(default="İnteraktif Araç", min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=300)
    data: Dict[str, Any] = Field(default_factory=dict)


# ============================================================
# SMART UI SİSTEM TALİMATI
# ============================================================

SMART_UI_SYSTEM_INSTRUCTION = """
# 🚀 SMART UI (İNTERAKTİF ARAYÜZ) TALİMATI
Kullanıcının isteği düz metinden çok etkileşimli bir arayüzden fayda görecekse, yanıtının SONUNA en fazla 3 adet Smart UI bloğu ekle.

Blok biçimi (JSON çiti):
```smart-ui
{
  "type": "<bileşen_tipi>",
  "title": "Kısa başlık",
  "description": "İsteğe bağlı kısa açıklama",
  "data": { }
}
```

Desteklenen tipler ve veri şemaları (şemaya birebir uy; fazladan alan ekleme):
1. calculator: {"initial_value": 0, "formula": "25 * 4"}
2. task_manager: {"tasks": [{"id": "1", "title": "Gereksinimleri belirle", "done": true, "priority": "high"}]}  // priority: low|medium|high
3. budget_planner: {"currency": "TL", "income": 45000, "expenses": [{"title": "Kira", "amount": 15000, "category": "Ev"}]}
4. calendar: {"events": [{"title": "Lumina Sunumu", "date": "2026-10-15", "time": "14:00"}]}  // tarih YYYY-AA-GG, saat SS:DD
5. unit_converter: {"category": "length", "from_unit": "metre", "to_unit": "feet", "value": 10}  // category: length|mass|time|volume|data
6. project_roadmap: {"milestones": [{"title": "Analiz", "status": "done", "progress": 100, "due": "2026-11-10", "tasks": ["Gereksinim listesi"]}]}  // status: planned|in_progress|done|blocked
7. study_planner: {"schedule": [{"day": "Pazartesi", "subject": "Matematik (Türev)", "duration": "45 dk"}]}
8. comparison_table: {"headers": ["Özellik", "Seçenek A", "Seçenek B"], "rows": [["Fiyat", "Ücretsiz", "150 TL"], ["Hız", "Standart", "Ultra Hızlı"]]}
9. interactive_form: {"fields": [{"name": "fullname", "label": "Ad Soyad", "type": "text", "required": true}]}  // type: text|textarea|number|email|date|select|checkbox|range | select için options zorunlu
10. checklist: {"items": [{"text": "Sunumu hazırla", "done": false}, {"text": "Toplantı linkini gönder", "done": true}]}
11. progress_tracker: {"goals": [{"label": "Kitap okuma", "current": 120, "target": 300, "unit": "sayfa"}]}  // target > 0
12. data_table: {"columns": ["Ürün", "Adet", "Fiyat"], "rows": [["Kalem", "2", "40 TL"]], "caption": "Sipariş özeti"}

KONUM / HAVA / YOL TARİFİ BLOKLARI (YALNIZCA SUNUCU ÜRETİR):
- location_results, weather_forecast, route_info, location_request ve location_info tipleri canlı sağlayıcı verisinden backend tarafından eklenir.
- Bu tipleri SEN ÜRETME. Kullanıcı hava durumu, yakın mekân veya yol tarifi isterse yalnızca doğal dille yanıtla; canlı veri bloğu sunucu tarafından eklenir.
- Konum, işletme, puan, mesafe veya hava tahmini UYDURMA. Veri yoksa bunu açıkça söyle.

KESİN GÜVENLİK KURALLARI:
- JSON dışında hiçbir şey yazma; HTML, <script>, JavaScript, olay işleyicisi (onclick vb.) veya çalıştırılabilir kod ASLA üretme.
- `javascript:`, `data:` veya `vbscript:` bağlantıları kullanma.
- Tüm metinler düz metin olmalı; biçimlendirme için Markdown kullanma.
- Şemada tanımlı olmayan alan ekleme; listeleri makul uzunlukta tut.
- Blokları yanıt metninin en sonuna koy; kullanıcıya görünen metin içinde ham JSON bırakma.
""".strip()


# ============================================================
# TEMİZLEME (DEFENSE-IN-DEPTH)
# ============================================================

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_DANGEROUS_SCHEMES_RE = re.compile(r"(?i)\b(?:javascript|vbscript|data)\s*:")
_SCRIPT_BLOCK_RE = re.compile(r"<\s*script[^>]*>[\s\S]*?<\s*/\s*script\s*>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]{0,500}>")
_DANGEROUS_KEYS = {"__proto__", "constructor", "prototype"}


def _sanitize_string(value: str, max_len: int = MAX_STRING_LEN) -> str:
    """Metni normalize eder: kontrol karakterleri, etiketler ve tehlikeli şemalar."""
    if not isinstance(value, str):
        return value
    cleaned = _SCRIPT_BLOCK_RE.sub("", value)
    cleaned = _CONTROL_CHARS_RE.sub("", cleaned)
    cleaned = _TAG_RE.sub("", cleaned)
    cleaned = _DANGEROUS_SCHEMES_RE.sub("", cleaned)
    cleaned = cleaned.replace("<", "").replace(">", "").strip()
    return cleaned[:max_len]


def sanitize_smart_ui_payload(payload: Any, _depth: int = 0) -> Any:
    """Yapıyı bozmadan tüm metinleri temizler; tehlikeli anahtarları atar."""
    if _depth > 12:
        return {}
    if isinstance(payload, str):
        return _sanitize_string(payload)
    if isinstance(payload, list):
        return [sanitize_smart_ui_payload(item, _depth + 1) for item in payload[:MAX_LIST_ITEMS]]
    if isinstance(payload, dict):
        cleaned: Dict[str, Any] = {}
        for key, value in list(payload.items())[:MAX_LIST_ITEMS]:
            if not isinstance(key, str) or key in _DANGEROUS_KEYS:
                continue
            cleaned[key[:80]] = sanitize_smart_ui_payload(value, _depth + 1)
        return cleaned
    return payload


# ============================================================
# DOĞRULAMA
# ============================================================

def _format_validation_error(exc: ValidationError) -> List[str]:
    errors: List[str] = []
    for err in exc.errors()[:8]:
        loc = ".".join(str(p) for p in err.get("loc", ()) if p != "__root__")
        errors.append(f"{loc or 'veri'}: {err.get('msg', 'geçersiz değer')}")
    return errors


def validate_smart_ui_block(raw: Any) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """Tek bir ham bloğu doğrular. Dönen: (geçerli_blok | None, hatalar)."""
    if not isinstance(raw, dict):
        return None, ["Blok bir JSON nesnesi olmalıdır."]

    try:
        raw_size = len(json.dumps(raw, ensure_ascii=False))
    except (TypeError, ValueError):
        return None, ["Blok JSON olarak serileştirilemedi."]
    if raw_size > MAX_RAW_BLOCK_CHARS:
        return None, [f"Blok çok büyük ({raw_size} bayt)."]

    try:
        envelope = SmartUIEnvelope.model_validate(raw)
    except ValidationError as exc:
        return None, _format_validation_error(exc)

    ui_type = envelope.type.lower().strip()
    if ui_type not in SUPPORTED_UI_TYPES:
        return None, [f"Desteklenmeyen bileşen tipi: {envelope.type}"]

    schema = SCHEMA_REGISTRY.get(ui_type)
    if schema is None:
        return None, [f"Bileşen şeması tanımlı değil: {ui_type}"]

    sanitized = sanitize_smart_ui_payload(envelope.data)
    try:
        validated_data = schema.model_validate(sanitized)
    except ValidationError as exc:
        return None, _format_validation_error(exc)

    block = {
        "type": ui_type,
        "title": _sanitize_string(envelope.title, 120) or "İnteraktif Araç",
        "description": _sanitize_string(envelope.description, 300) if envelope.description else None,
        "data": validated_data.model_dump(mode="json"),
    }
    return block, []


def validate_smart_ui_payload(ui_type: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """API doğrulama uç noktası için yardımcı. Geçerliyse temizlenmiş veriyi döner."""
    block, errors = validate_smart_ui_block({
        "type": ui_type,
        "title": "Doğrulama",
        "data": data if isinstance(data, dict) else {},
    })
    return {
        "valid": block is not None,
        "errors": errors,
        "sanitized_data": block["data"] if block else {},
    }


# ============================================================
# BLOK ÇIKARMA / TEMİZLEME
# ============================================================

SMART_UI_REGEX = re.compile(r"```smart-ui\s*([\s\S]*?)\s*```", re.IGNORECASE)
_ANY_FENCE_LEFTOVER_RE = re.compile(r"```(?:\s|\n)*$")


def extract_smart_ui_blocks(text: str, *, include_server_only: bool = False) -> List[Dict[str, Any]]:
    """Metindeki smart-ui bloklarını güvenle ayrıştırır, doğrular ve sınırlar.

    Server-only types (location/weather/route) are rejected unless the caller
    explicitly opts in, so a model can never fabricate live data.
    """
    if not text or not isinstance(text, str):
        return []

    blocks: List[Dict[str, Any]] = []
    total_bytes = 0
    for match in SMART_UI_REGEX.finditer(text):
        if len(blocks) >= MAX_BLOCKS_PER_REPLY:
            break
        raw_json = (match.group(1) or "").strip()
        if not raw_json or len(raw_json) > MAX_RAW_BLOCK_CHARS:
            continue
        total_bytes += len(raw_json.encode("utf-8", errors="ignore"))
        if total_bytes > MAX_TOTAL_BLOCKS_BYTES:
            break
        try:
            raw = json.loads(raw_json)
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
        block, _errors = validate_smart_ui_block(raw)
        if not block:
            continue
        if not include_server_only and block["type"] in SERVER_ONLY_UI_TYPES:
            continue
        blocks.append(block)
    return blocks


def strip_smart_ui_blocks(text: str) -> str:
    """Metindeki tüm smart-ui çitlerini kaldırır; kullanıcıya ham JSON göstermez."""
    if not text:
        return ""
    cleaned = SMART_UI_REGEX.sub("", text)
    cleaned = _ANY_FENCE_LEFTOVER_RE.sub("", cleaned.strip())
    return cleaned.strip()


def get_smart_ui_catalog() -> Dict[str, Any]:
    """Frontend ve dokümantasyon için bileşen kataloğu."""
    return {
        "max_blocks_per_reply": MAX_BLOCKS_PER_REPLY,
        "types": [
            {"type": t, "label": SMART_UI_TYPE_LABELS_TR[t], "schema": SCHEMA_REGISTRY[t].model_json_schema()}
            for t in sorted(SUPPORTED_UI_TYPES)
        ],
    }
