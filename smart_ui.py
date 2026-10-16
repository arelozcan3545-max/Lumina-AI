# ============================================================
# LUMINA AI - SMART UI ENGINE (ŞEMA & GÜVENLİK MODELİ)
# Güvenli, Kum Havuzlu ve İnteraktif Arayüz Bileşen Kaydı
# ============================================================

import re
import json
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field, ValidationError

# Desteklenen Güvenli Bileşen Tipleri
SUPPORTED_UI_TYPES = {
    "calculator",
    "task_manager",
    "budget_planner",
    "calendar",
    "unit_converter",
    "project_roadmap",
    "study_planner",
    "comparison_table",
    "code_sandbox",
    "interactive_form"
}

# ============================================================
# Pydantic Doğrulama Şemaları (Katı Şema Doğrulama)
# ============================================================

class SmartUIEnvelope(BaseModel):
    type: str
    title: str = Field(default="İnteraktif Araç", max_length=120)
    description: Optional[str] = Field(default=None, max_length=300)
    data: Dict[str, Any] = Field(default_factory=dict)

# ============================================================
# SMART UI SİSTEM TALİMATI
# ============================================================

SMART_UI_SYSTEM_INSTRUCTION = """
# 🚀 SMART UI (İNTERAKTİF UYGULAMA ARAYÜZLERİ) TALİMATI:
Kullanıcının isteği sadece düz metin yerine etkileşimli bir arayüzden fayda görecekse (hesap makinesi, yapılacaklar listesi, bütçe tablosu, takvim, birim çevirici, proje panosu, ders programı, karşılaştırma tablosu, interaktif form gibi), yanıtının sonuna bir Smart UI bileşeni ekle.

Smart UI bloğunu tam olarak şu biçimde oluştur:
```smart-ui
{
  "type": "calculator" | "task_manager" | "budget_planner" | "calendar" | "unit_converter" | "project_roadmap" | "study_planner" | "comparison_table" | "interactive_form",
  "title": "Arayüz Başlığı",
  "description": "Kısa açıklama",
  "data": { ... }
}
```

Örnek Veri Şablonları:
1. "calculator": {"initial_value": 0, "formula": "25 * 4"}
2. "task_manager": {"tasks": [{"id": "1", "title": "Gereksinimleri belirle", "done": true}, {"id": "2", "title": "Tasarımı çiz", "done": false, "priority": "high"}]}
3. "budget_planner": {"currency": "TL", "income": 45000, "expenses": [{"title": "Kira", "amount": 15000, "category": "Ev"}, {"title": "Market", "amount": 6000, "category": "Gıda"}]}
4. "calendar": {"events": [{"title": "Lumina Sunumu", "date": "2026-10-15", "time": "14:00"}]}
5. "unit_converter": {"category": "length", "from_unit": "metre", "to_unit": "feet", "value": 10}
6. "study_planner": {"schedule": [{"day": "Pazartesi", "subject": "Matematik (Türev)", "duration": "45 dk"}, {"day": "Salı", "subject": "Fizik (Kuvvet)", "duration": "60 dk"}]}
7. "comparison_table": {"headers": ["Özellik", "Seçenek A", "Seçenek B"], "rows": [["Fiyat", "Ücretsiz", "150 TL"], ["Hız", "Standart", "Ultra Hızlı"]]}
8. "interactive_form": {"fields": [{"name": "fullname", "label": "Ad Soyad", "type": "text"}, {"name": "rating", "label": "Memnuniyet Puanı", "type": "number", "min": 1, "max": 5}]}

Asla rastgele zararlı JavaScript veya denetlenmeyen HTML kodları yazma; sadece güvenli JSON verisi döndür.
""".strip()

# ============================================================
# YARDIMCI VE DOĞRULAMA FONKSİYONLARI
# ============================================================

SMART_UI_REGEX = re.compile(r"```smart-ui\s*([\s\S]*?)\s*```", re.IGNORECASE)

def extract_smart_ui_blocks(text: str) -> List[Dict[str, Any]]:
    """Metin içindeki smart-ui bloklarını güvenle ayrıştırır ve doğrular."""
    if not text:
        return []

    found = []
    matches = SMART_UI_REGEX.findall(text)
    for raw_json in matches:
        try:
            clean_str = raw_json.strip()
            data = json.loads(clean_str)
            envelope = SmartUIEnvelope.model_validate(data)
            if envelope.type in SUPPORTED_UI_TYPES:
                found.append(envelope.model_dump())
        except Exception:
            continue
    return found

def strip_smart_ui_blocks(text: str) -> str:
    """Metindeki tüm smart-ui bloklarını (çitleriyle birlikte) kaldırır.

    Yanıt metni frontend'e temiz iletilir; interaktif bileşenler ayrı `smart_ui`
    listesinde döndüğü için ham JSON çitlerinin kullanıcının göreceği metinde
    şişkinlik/dağınıklık yaratması istenmemiştir.
    """
    if not text:
        return ""
    cleaned = SMART_UI_REGEX.sub("", text)
    # Blok artıklarında bırakılan boş ``` çitlerini de temizle
    cleaned = re.sub(r"```(?:\s|\n)*$", "", cleaned.strip())
    return cleaned.strip()


def sanitize_smart_ui_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Zararlı XSS veya komut enjeksiyonlarını temizler."""
    if not isinstance(payload, dict):
        return {}

    sanitized = {}
    for k, v in payload.items():
        if isinstance(v, str):
            # Script etiketlerini ve tehlikeli URI şemalarını temizle
            clean_val = re.sub(r"<\s*script[^>]*>[\s\S]*?<\s*/\s*script\s*>", "", v, flags=re.IGNORECASE)
            clean_val = re.sub(r"javascript\s*:", "", clean_val, flags=re.IGNORECASE)
            sanitized[k] = clean_val
        elif isinstance(v, list):
            sanitized[k] = [sanitize_smart_ui_payload(item) if isinstance(item, dict) else item for item in v]
        elif isinstance(v, dict):
            sanitized[k] = sanitize_smart_ui_payload(v)
        else:
            sanitized[k] = v
    return sanitized
