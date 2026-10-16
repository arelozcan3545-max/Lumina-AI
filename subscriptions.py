# ============================================================
# LUMINA AI - SUBSCRIPTIONS & ENTITLEMENTS SYSTEM
# Sunucu Yetkili Abonelik, Kota, Duo/Aile Yönetimi ve Dinamik Fiyatlandırma
# ============================================================

import time
import datetime
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field

# Zaman dilimi: Türkiye (UTC+3)
TURKEY_TZ_OFFSET = datetime.timezone(datetime.timedelta(hours=3))

def get_today_str() -> str:
    """Türkiye saatiyle bugünün tarihini (YYYY-MM-DD) döner."""
    return datetime.datetime.now(TURKEY_TZ_OFFSET).strftime("%Y-%m-%d")

# ============================================================
# 10 PAKET TANIMI & KOTALAR
# ============================================================

SUBSCRIPTION_PLANS: Dict[str, Dict[str, Any]] = {
    "standart": {
        "id": "standart",
        "name": "Standart Paket",
        "price_tl": 0,
        "billing_period": "aylık",
        "description": "Lumina AI dünyasına ücretsiz ve hızlı giriş.",
        "badge": "Ücretsiz",
        "model_tier": "Standart (Gemini 3.6 Flash / GPT-OSS 120B)",
        "messages_per_day": 250,
        "images_per_day": 5,
        "images_per_conversation": 5,
        "max_members": 1,
        "features": [
            "Günde 250 sohbet mesajı",
            "Günde 5 ultra gerçekçi görsel (Flux Realism)",
            "Standart yapay zeka modellerine erişim",
            "Temel sohbet ve kalıcı hafıza desteği",
            "KaTeX matematik ve bilim çözücü",
            "Smart UI interaktif arayüz desteği"
        ],
        "is_unlimited_text": False,
        "is_unlimited_image": False,
        "recommended": False
    },
    "ekonomi": {
        "id": "ekonomi",
        "name": "Ekonomi Paket",
        "price_tl": 150,
        "billing_period": "aylık",
        "description": "Bireysel kullanıcılar için yüksek kotalı ve hesaplı çözüm.",
        "badge": "Popüler",
        "model_tier": "Hızlı & Gelişmiş (Gemini 3.5 Flash / GPT-OSS 20B)",
        "images_per_day": 25,
        "images_per_conversation": 15,
        "max_members": 1,
        "features": [
            "Günde 1.000 sohbet mesajı",
            "Günde 25 yüksek çözünürlüklü görsel üretimi",
            "Gelişmiş akıl yürütme ve kodlama desteği",
            "Öncelikli yanıt süresi",
            "Canlı internet araştırması ve kaynak linkleri",
            "Kapsamlı Smart UI araçları ve dosya analizi"
        ],
        "is_unlimited_text": False,
        "is_unlimited_image": False,
        "recommended": False
    },
    "duo_ekonomi": {
        "id": "duo_ekonomi",
        "name": "Duo Boyu Ekonomi Paket",
        "price_tl": 300,
        "billing_period": "aylık",
        "description": "İki kişi için ortak abonelik, bağımsız ve gizli hesaplar.",
        "badge": "2 Kişilik",
        "model_tier": "Hızlı & Gelişmiş (Gemini 3.5 Flash / GPT-OSS 20B)",
        "messages_per_day": 1500,  # Kişi başı günlük kota
        "images_per_day": 35,
        "images_per_conversation": 20,
        "max_members": 2,
        "features": [
            "Yetkilendirilmiş 2 ayrı kullanıcı hesabı",
            "Tamamen bağımsız ve gizli sohbet geçmişi",
            "Her üye için günlük 1.500 mesaj kotası",
            "Günde 35 görsel üretimi",
            "Güvenli e-posta ile davet ve üye yönetimi",
            "Gelişmiş araştırma ve kod asistanı"
        ],
        "is_unlimited_text": False,
        "is_unlimited_image": False,
        "recommended": False
    },
    "aile_ekonomi": {
        "id": "aile_ekonomi",
        "name": "Aile Boyu Ekonomi Paket",
        "price_tl": 400,
        "billing_period": "aylık",
        "description": "3 ile 5 aile üyesi için en avantajlı çoklu kullanıcı paketi.",
        "badge": "Aile (3-5 Kişi)",
        "model_tier": "Hızlı & Gelişmiş (Gemini 3.5 Flash / GPT-OSS 20B)",
        "messages_per_day": 2000,  # Kişi başı günlük kota
        "images_per_day": 50,
        "images_per_conversation": 25,
        "max_members": 5,
        "features": [
            "3 ila 5 yetkili aile üyesi",
            "Ayrı kullanıcı hesapları ve gizli sohbet odaları",
            "Her üye için bağımsız kullanım takibi (2.000 mesaj/gün)",
            "Günde 50 görsel üretimi",
            "Kolay aile paneli: üye ekleme ve çıkarma",
            "Tüm yaşlara uygun güvenlik filtresi"
        ],
        "is_unlimited_text": False,
        "is_unlimited_image": False,
        "recommended": False
    },
    "pro": {
        "id": "pro",
        "name": "Pro Paket",
        "price_tl": 500,
        "billing_period": "aylık",
        "description": "Profesyonel geliştiriciler ve araştırmacılar için Gemini 3.8 Flash gücü.",
        "badge": "Profesyonel",
        "model_tier": "Premium Gemini (Gemini 3.8 Flash / 3.6 Flash)",
        "messages_per_day": 3000,
        "images_per_day": 60,
        "images_per_conversation": 30,
        "max_members": 1,
        "features": [
            "Premium Google Gemini 3.8 Flash & 3.6 Flash modellerine erişim",
            "Günde 3.000 mesaj ve derin akıl yürütme",
            "Günde 60 yüksek kaliteli görsel",
            "Çoklu ajan yazılım hattı (Mimar + Geliştirici + QA)",
            "Büyük dosya, PDF ve kod deposu analizi",
            "Öncelikli sunucu işleme sırası"
        ],
        "is_unlimited_text": False,
        "is_unlimited_image": False,
        "recommended": True
    },
    "pro_plus": {
        "id": "pro_plus",
        "name": "Pro+ Paket",
        "price_tl": 650,
        "billing_period": "aylık",
        "description": "Sınırsız metin sohbeti (adil kullanım) ve üst düzey kodlama.",
        "badge": "Gelişmiş Pro",
        "model_tier": "En İyi Gemini Modeli (Gemini 3.8 Flash)",
        "messages_per_day": 5000,  # Adil kullanım kotası
        "images_per_day": 80,
        "images_per_conversation": 40,
        "max_members": 1,
        "features": [
            "En iyi Gemini 3.8 Flash modeline doğrudan erişim",
            "Sınırsız metin sohbeti (Adil kullanım: 5.000 mesaj/gün)",
            "Fatura döneminde 15 ultra sinematik özel görsel hakkı",
            "Üstün kod yazımı, refactoring ve hata ayıklama",
            "Gelişmiş bağlam penceresi (uzun belge analizi)",
            "Öncelikli destek ve kesintisiz bant genişliği"
        ],
        "is_unlimited_text": True,
        "is_unlimited_image": False,
        "recommended": False
    },
    "luks": {
        "id": "luks",
        "name": "Lüks Paket",
        "price_tl": 850,
        "billing_period": "aylık",
        "description": "Ultra düşük gecikme, sınırsız konuşma ve görsel üretimi.",
        "badge": "Lüks",
        "model_tier": "En İyi Gemini Modeli + Düşük Gecikme",
        "messages_per_day": 7500,  # Adil kullanım
        "images_per_day": 120,    # Adil kullanım
        "images_per_conversation": 50,
        "max_members": 1,
        "features": [
            "En güçlü Gemini modeline anında erişim",
            "Sınırsız metin konuşması (Adil kullanım: 7.500 mesaj/gün)",
            "Sınırsız görsel üretimi (Adil kullanım: 120 görsel/gün)",
            "En düşük gecikme süresi (Ultra Low Latency)",
            "Tüm Smart UI şablonları ve canlı dashboard'lar",
            "VIP sunucu tahsisi"
        ],
        "is_unlimited_text": True,
        "is_unlimited_image": True,
        "recommended": False
    },
    "premium": {
        "id": "premium",
        "name": "Premium Paket",
        "price_tl": 900,
        "billing_period": "aylık",
        "description": "Lumina AI'ın en gelişmiş yönlendirme ve çoklu ajan ekosistemi.",
        "badge": "Premium",
        "model_tier": "Lumina Amiral Gemisi Model Yönlendirmesi",
        "messages_per_day": 10000,
        "images_per_day": 150,
        "images_per_conversation": 60,
        "max_members": 1,
        "features": [
            "Lumina AI akıllı model yönlendirme ve sentez motoru",
            "Sınırsız sohbet (Adil kullanım: 10.000 mesaj/gün)",
            "Sınırsız görsel stüdyosu kullanımı",
            "Gelişmiş talimat takibi ve sıfır halüsinasyon filtresi",
            "Karmaşık teknik sorun çözme ve mimari danışmanlık",
            "7/24 kesintisiz yüksek öncelikli servis"
        ],
        "is_unlimited_text": True,
        "is_unlimited_image": True,
        "recommended": False
    },
    "premium_plus": {
        "id": "premium_plus",
        "name": "Premium Plus Paket",
        "price_tl": 1000,
        "billing_period": "aylık",
        "description": "Platformun en üst seviye donanım ve yapay zeka ayrıcalığı.",
        "badge": "En Üst Seviye",
        "model_tier": "Amiral Gemisi + Özel Lumina AI Yönlendirmesi",
        "messages_per_day": 15000,
        "images_per_day": 200,
        "images_per_conversation": 100,
        "max_members": 1,
        "features": [
            "Tüm Lumina AI ve Gemini amiral gemisi modellerine sınırsız erişim",
            "En yüksek sistem önceliği ve sıfır bekleme süresi",
            "Gelişmiş görsel düzenleme ve varyasyon seçenekleri",
            "Genişletilmiş kalıcı hafıza ve sınırsız profil analizi",
            "Tüm yeni beta özelliklerine erken erişim",
            "Tam teşekküllü kurumsal düzey güvenilirlik"
        ],
        "is_unlimited_text": True,
        "is_unlimited_image": True,
        "recommended": False
    },
    "custom": {
        "id": "custom",
        "name": "Custom Paket (Özel)",
        "price_tl": 0,  # Dinamik hesaplanır
        "billing_period": "aylık",
        "description": "İhtiyacınıza göre mesaj, görsel ve model seçerek kendi paketinizi oluşturun.",
        "badge": "Özel Tasarım",
        "model_tier": "Kullanıcı Seçimi",
        "messages_per_day": 0,
        "images_per_day": 0,
        "images_per_conversation": 10,
        "max_members": 1,
        "features": [
            "Tamamen ihtiyaca özel esnek kota",
            "İstenen model seviyesi (Standart / Pro / Amiral Gemisi)",
            "İsteğe bağlı ek ekip/aile üyesi ekleme",
            "Şeffaf ve anlık maliyet dökümü"
        ],
        "is_unlimited_text": False,
        "is_unlimited_image": False,
        "recommended": False
    }
}

# ============================================================
# ÖZEL PAKET (CUSTOM PLAN) FİYAT HESAPLAMA MOTORU
# ============================================================

class CustomPlanRequest(BaseModel):
    messages_per_day: int = Field(default=1000, ge=250, le=20000)
    images_per_day: int = Field(default=20, ge=5, le=500)
    model_tier: str = Field(default="pro")  # "standard", "pro", "flagship"
    seats: int = Field(default=1, ge=1, le=10)
    enable_web_research: bool = Field(default=True)
    enable_code_assistant: bool = Field(default=True)
    extra_storage_mb: int = Field(default=100, ge=0, le=5000)

def calculate_custom_plan_price(req: CustomPlanRequest) -> Dict[str, Any]:
    """Sunucu tarafında adil, şeffaf ve manipüle edilemez özel fiyat hesabı yapar."""
    base_fee = 75.0  # Temel altyapı ücreti (TL)

    # 1. Mesaj kotası maliyeti: 1.000 mesaj başına ~35 TL
    msg_cost = (req.messages_per_day / 1000.0) * 35.0

    # 2. Görsel kotası maliyeti: 10 görsel başına ~20 TL
    img_cost = (req.images_per_day / 10.0) * 20.0

    # 3. Model seviyesi katsayısı
    tier_multipliers = {
        "standard": 1.0,
        "pro": 1.45,
        "flagship": 1.95
    }
    tier_mult = tier_multipliers.get(req.model_tier.lower(), 1.45)

    # 4. Ek modüller
    addons_cost = 0.0
    if req.enable_web_research:
        addons_cost += 25.0
    if req.enable_code_assistant:
        addons_cost += 35.0
    if req.extra_storage_mb > 0:
        addons_cost += (req.extra_storage_mb / 500.0) * 15.0

    # Tek koltuk için toplam
    single_seat_total = (base_fee + msg_cost + img_cost + addons_cost) * tier_mult

    # Ek kullanıcılar (koltuk) için %35 indirimli ilave ücret
    if req.seats > 1:
        additional_seats_cost = (req.seats - 1) * (single_seat_total * 0.65)
        total_monthly_price = round(single_seat_total + additional_seats_cost, -1)
    else:
        total_monthly_price = round(single_seat_total, -1)

    # En az 100 TL
    total_monthly_price = max(100, int(total_monthly_price))

    breakdown = {
        "base_platform_fee_tl": round(base_fee, 2),
        "message_quota_fee_tl": round(msg_cost, 2),
        "image_quota_fee_tl": round(img_cost, 2),
        "addons_fee_tl": round(addons_cost, 2),
        "model_tier": req.model_tier,
        "model_tier_multiplier": tier_mult,
        "seats": req.seats,
        "total_monthly_price_tl": total_monthly_price,
        "billing_period": "aylık"
    }

    return {
        "success": True,
        "price_tl": total_monthly_price,
        "breakdown": breakdown,
        "plan_config": {
            "messages_per_day": req.messages_per_day,
            "images_per_day": req.images_per_day,
            "model_tier": req.model_tier,
            "seats": req.seats,
            "enable_web_research": req.enable_web_research,
            "enable_code_assistant": req.enable_code_assistant
        }
    }

# ============================================================
# KULLANICI KOTA & YETKİLENDİRME YÖNETİCİSİ
# ============================================================

def get_effective_plan(user_profile: dict) -> dict:
    """Kullanıcının aktif paketini döner."""
    tier = (user_profile.get("subscription_tier") or "standart").lower()
    if tier == "custom" and user_profile.get("custom_plan_config"):
        base_custom = dict(SUBSCRIPTION_PLANS["custom"])
        cfg = user_profile["custom_plan_config"]
        base_custom["messages_per_day"] = cfg.get("messages_per_day", 1000)
        base_custom["images_per_day"] = cfg.get("images_per_day", 20)
        base_custom["price_tl"] = user_profile.get("subscription_price", 250)
        return base_custom
    return SUBSCRIPTION_PLANS.get(tier, SUBSCRIPTION_PLANS["standart"])

def get_or_reset_daily_usage(user_profile: dict) -> dict:
    """Günlük kullanım sayacını kontrol eder, gün değiştiyse sıfırlar."""
    today = get_today_str()
    usage = user_profile.setdefault("daily_usage", {})
    last_date = usage.get("date")

    if last_date != today:
        usage["date"] = today
        usage["messages"] = 0
        usage["images"] = 0

    return usage
