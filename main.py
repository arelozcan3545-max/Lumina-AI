# ============================================================
# LUMINA AI - ADVANCED BACKEND ENGINE (ENTERPRISE v3.1)
# FastAPI + Multi-Agent Architecture + Resilience Cascade
# Google Gemini (Official) + Groq + GitHub Models + Flux Studio
# 10 Kademeli Sunucu Yetkili Abonelik & Smart UI İnteraktif Motoru
#
# ONARIM NOTU (16 Ekim 2026):
#   - CORS beyaz listeye çekildi (önceden tüm HTTP kaynaklarına açıktı)
#   - Kota sayacı tek kilit altında atomik hale getirildi (yarış koşulu giderildi)
#   - Aile/Duo paket yetkisi üyeye otomatik yayılır
#   - "Misafir tokendan" Firestore profilleri kullanılabilir
#   - verify_token artık geçersiz Firebase token'ı için 401 döner
#   - Belge analizi: TXT/MD/JSON/CSV + DOCX + PDF (pypdf kuruluysa)
#   - Görsel üretimi: Gemini Nano Banana (birincil) + Pollinations (yedek)
# ============================================================

import os
import re
import io
import json
import time
import random
import logging
import uuid
import base64
import datetime
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote
from collections import defaultdict, deque
from typing import Optional, List, Dict, Any

import requests
from fastapi import FastAPI, Depends, HTTPException, Header, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# Modüler Altyapı Bileşenleri
from subscriptions import (
    SUBSCRIPTION_PLANS,
    CustomPlanRequest,
    calculate_custom_plan_price,
    get_effective_plan,
    get_or_reset_daily_usage,
    get_today_str,
    TURKEY_TZ_OFFSET
)
from models_provider import (
    execute_chat_completion,
    stream_chat_completion,
    call_gemini,
    stream_gemini,
    call_groq,
    stream_groq,
    call_github_models,
    call_gemini_image,
    list_configured_providers,
    GEMINI_API_KEY,
    GROQ_API_KEY,
    GITHUB_TOKEN,
    GEMINI_MODEL_HIGH,
    GEMINI_IMAGE_MODEL,
    ProviderError,
    ProviderConfigurationError,
    ProviderAuthError,
    ProviderUnavailableError,
    ContentSafetyProviderError
)
from smart_ui import (
    SMART_UI_SYSTEM_INSTRUCTION,
    extract_smart_ui_blocks,
    strip_smart_ui_blocks,
    sanitize_smart_ui_payload
)
from storage import get_store

# PDF desteği (opsiyonel bağımlılık)
try:
    from pypdf import PdfReader
    HAS_PYPDF = True
except ImportError:
    HAS_PYPDF = False

# Optional Firebase Admin SDK
try:
    import firebase_admin
    from firebase_admin import credentials, auth
    HAS_FIREBASE_MODULE = True
except ImportError:
    HAS_FIREBASE_MODULE = False

# ============================================================
# ENVIRONMENT & LOGGING
# ============================================================

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("LuminaBackend")

# ============================================================
# FASTAPI APP
# ============================================================

app = FastAPI(
    title="Lumina AI Engine",
    version="3.1.0",
    description="Lumina AI Enterprise Multi-Agent & Smart UI Engine with 10 Subscription Tiers"
)

# ============================================================
# CORS CONFIGURATION (SIKI BEYAZ LİSTE — GÜVENLİK ONARIMI)
# ============================================================

_allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "").strip()

if _allowed_origins_env:
    ALLOWED_ORIGINS = [o.strip() for o in _allowed_origins_env.split(",") if o.strip()]
else:
    ALLOWED_ORIGINS = [
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:8010",
        "http://localhost:8010",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ]

app.add_middleware(
    CORSMiddleware,
    # ✅ ONARIM: eski `https?://.*` deseni her siteye kimlik belgeli erişim veriyordu.
    # Artık yalnızca beyaz listedeki kaynaklar kabul edilir (ALLOWED_ORIGINS env ile genişletilebilir).
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# ============================================================
# FIREBASE & DAYANIKLI DEPOSU (lumina-ai-a42e0)
# ============================================================

FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "lumina-ai-a42e0")
FIREBASE_KEY_PATH = os.getenv("FIREBASE_KEY_PATH", "serviceAccountKey.json")
FIREBASE_DATABASE_URL = os.getenv(
    "FIREBASE_DATABASE_URL",
    f"https://{FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com"
)

FIREBASE_ENABLED = False

# Anahtar dosyası arama önceliği: serviceAccountKey.json -> firebase-key.json
candidate_keys = [
    FIREBASE_KEY_PATH,
    "serviceAccountKey.json",
    "firebase-key.json",
    os.path.join(os.path.dirname(__file__), "serviceAccountKey.json"),
    os.path.join(os.path.dirname(__file__), "firebase-key.json")
]

selected_key = None
for k in candidate_keys:
    if os.path.exists(k):
        selected_key = k
        break

if HAS_FIREBASE_MODULE and selected_key:
    try:
        if not firebase_admin._apps:
            cred = credentials.Certificate(selected_key)
            firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_DATABASE_URL})
        FIREBASE_ENABLED = True
        logger.info(f"Firebase Admin SDK başarıyla bağlandı ({FIREBASE_PROJECT_ID}).")
    except Exception as exc:
        logger.warning(f"Firebase başlatılamadı, yerel hafıza moduna geçiliyor: {exc}")
        FIREBASE_ENABLED = False
else:
    logger.info(f"Firebase servis anahtarı ({selected_key or FIREBASE_KEY_PATH}) bulunamadı. Yerel Hafıza & Misafir Modu devrede.")

# Dayanıklı depo katmanı (atomik yerel JSON + opsiyonel Firestore aynası)
LOCAL_MEMORY_FILE = os.path.join(os.path.dirname(__file__), "lumina_memory.json")

_firestore_client = None
if FIREBASE_ENABLED:
    try:
        from firebase_admin import firestore as _fb_firestore
        _firestore_client = _fb_firestore.client()
    except Exception as exc:
        logger.warning(f"Firestore istemcisi başlatılamadı (yerel modda devam): {exc}")

store = get_store(LOCAL_MEMORY_FILE, firebase_enabled=FIREBASE_ENABLED, firestore_client=_firestore_client)

# Firestore profiller aktifse buluttan öncelikli indirilir (limitli senkronizasyon)
if store.firebase_enabled:
    synced = store.sync_profiles_from_firestore()
    if synced:
        logger.info(f"Firestore'dan {synced} profil senkronize edildi.")

def load_local_store() -> dict:
    """Geriye uyumluluk sarmalayıcısı — tüm kayıtlı veriyi döner."""
    return store.load_all()

def save_local_store(data: dict):
    """Geriye uyumluluk sarmalayıcısı — tüm deponun üzerine yazar (atomik)."""
    store.save_all(data)

# ============================================================
# STATİK GÖRSEL DOSYALARI (/media)
# ============================================================

MEDIA_DIR = os.path.join(os.path.dirname(__file__), "media")
os.makedirs(MEDIA_DIR, exist_ok=True)

app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")

def _save_base64_image(image_b64: str, mime_type: str = "image/png") -> Optional[str]:
    """Base64 görseli /media klasörüne kaydeder; dönen değer dosya adıdır."""
    try:
        clean = image_b64.strip()
        if clean.startswith("data:"):
            # data:image/png;base64,XXXX biçimini soy
            header, _, clean = clean.partition(",")
            if "png" in header:
                mime_type = "image/png"
            elif "jpeg" in header or "jpg" in header:
                mime_type = "image/jpeg"
        extension = "png" if "png" in mime_type else "jpg" if ("jpeg" in mime_type or "jpg" in mime_type) else "webp"
        image_bytes = base64.b64decode(clean, validate=True)
        filename = f"lumina_{int(time.time())}_{random.randint(1000, 9999)}.{extension}"
        filepath = os.path.join(MEDIA_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(image_bytes)
        return filename
    except Exception as exc:
        logger.warning(f"Base64 görsel kaydedilemedi: {exc}")
        return None

# ============================================================
# KULLANICI PROFİLİ, ABONELİK VE KOTALAR
# ============================================================

def _default_profile_factory(uid: str) -> dict:
    return {
        "uid": uid,
        "name": None,
        "facts": [],
        "subscription_tier": "standart",
        "subscription_status": "active",
        "created_at": int(time.time()),
        "daily_usage": {
            "date": get_today_str(),
            "messages": 0,
            "images": 0
        },
        "family_members": [],
        "subscription_events": []
    }

def get_or_create_user_profile(uid: str, email: Optional[str] = None) -> dict:
    """Kullanıcı profilini getirir / oluşturur ve aile planı yayılımını uygular."""
    profile = store.get_profile(uid, default_factory=lambda: _default_profile_factory(uid))
    get_or_reset_daily_usage(profile)
    if email:
        ensure_plan_inheritance(profile, email)
    return profile

def save_user_profile_full(uid: str, profile: dict):
    """Profilleri tamamen yazar (atomik + Firestore aynalı)."""
    store.set_profile(uid, profile)

def _append_subscription_event(profile: dict, event_type: str, payload: dict):
    """Abonelik olaylarını denetim izi (audit log) olarak profil içinde saklar."""
    events = profile.setdefault("subscription_events", [])
    events.append({
        "type": event_type,
        "payload": payload,
        "timestamp": int(time.time())
    })
    profile["subscription_events"] = events[-100:]

def ensure_plan_inheritance(profile: dict, email: str) -> None:
    """Aile / Duo plan sahibinin paket yetkisini üyeye otomatik yayar ve geri çeker.

    Kural: Üye, bir plan sahibinin `family_members` listesinde aktif durumdaysa ve
    o plan çok kişiyse (max_members >= 2), üyenin paketi sahibinin paketine eşitlenir.
    Üye listeden çıkarılırsa veya iptal edilirse tekrar Standart'a döner.
    """
    email_l = (email or "").strip().lower()
    if not email_l or "@" not in email_l:
        return

    owners = store.find_profiles_matching_email(email_l)

    inherited_tier = None
    owner_uid = None
    for o_uid, o_profile in owners:
        if o_uid == profile.get("uid"):
            continue  # kendisi plan sahibi ise yayılma uygulanmaz
        o_plan = get_effective_plan(o_profile)
        if o_plan.get("max_members", 1) < 2:
            continue  # tek kişilik planlarda yayılma yok
        member_entry = None
        for m in o_profile.get("family_members", []):
            if isinstance(m, dict) and m.get("email") == email_l and m.get("status") == "active":
                member_entry = m
                break
        if member_entry:
            inherited_tier = o_profile.get("subscription_tier", "standart")
            owner_uid = o_uid
            break

    current_tier = profile.get("subscription_tier", "standart")
    current_owner = profile.get("subscription_inherited_from")

    if inherited_tier and (current_tier != inherited_tier or current_owner != owner_uid):
        profile["subscription_tier"] = inherited_tier
        profile["subscription_inherited_from"] = owner_uid
        profile.pop("custom_plan_config", None)
        _append_subscription_event(profile, "plan_inherited", {"from_owner": owner_uid, "tier": inherited_tier})
        store.set_profile(profile.get("uid") or "_unknown", profile)
        logger.info(f"Plan yayılımı uygulandı: {email_l} → {inherited_tier} (sahip: {owner_uid})")
    elif not inherited_tier and current_owner:
        profile["subscription_tier"] = "standart"
        profile.pop("subscription_inherited_from", None)
        profile.pop("custom_plan_config", None)
        _append_subscription_event(profile, "plan_inheritance_revoked", {})
        store.set_profile(profile.get("uid") or "_unknown", profile)
        logger.info(f"Plan yayılımı geri çekildi: {email_l} → Standart")

def format_quota_response(uid: str, has_custom_key: bool = False) -> dict:
    """Frontend'in beklediği tutarlı kota ve abonelik dökümü."""
    profile = get_or_create_user_profile(uid)
    plan = get_effective_plan(profile)
    usage = get_or_reset_daily_usage(profile)

    msg_used = usage.get("messages", 0)
    msg_max = plan.get("messages_per_day", 250)
    img_used = usage.get("images", 0)
    img_max = plan.get("images_per_day", 5)

    unlimited_text = plan.get("is_unlimited_text", False)
    unlimited_image = plan.get("is_unlimited_image", False)

    return {
        "messages_used": msg_used,
        "messages_max": (msg_max if not unlimited_text else -1),
        "images_used": img_used,
        "images_max": (img_max if not unlimited_image else -1),
        "subscription_tier": plan["id"],
        "plan_name": plan["name"],
        "price_tl": plan.get("price_tl", 0),
        "is_unlimited_text": unlimited_text,
        "is_unlimited_image": unlimited_image,
        "images_per_conversation": plan.get("images_per_conversation", 10),
        "custom_key_active": has_custom_key,
        "today": usage.get("date", get_today_str())
    }

def check_and_increment_quota(
    uid: str,
    quota_type: str,
    has_custom_key: bool = False,
    conversation_id: Optional[str] = None
):
    """
    Kota kontrolü ve arttırımı — ATOMİK (tek kilit altında).
    Oku–değiştir–yaz işlemi `store.update_profile` içinde tek kilit (RLock) altında sarılmıştır:
    `store.update_profile` içinde RLock ile sarılmıştır.
    """
    if has_custom_key:
        return  # Özel API anahtarı sağlandıysa kota kısıtlaması uygulanmaz

    def _mutate(profile: dict):
        get_or_reset_daily_usage(profile)
        plan = get_effective_plan(profile)
        usage = profile.get("daily_usage", {})

        if quota_type == "messages":
            max_limit = plan.get("messages_per_day", 250)
            used = usage.get("messages", 0)
            if not plan.get("is_unlimited_text", False) and used >= max_limit:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        f"⚠️ Günlük mesaj kotanız dolmuştur ({used}/{max_limit}). "
                        f"Mevcut paketiniz: {plan['name']}. "
                        "Daha yüksek kotalara ve gelişmiş yapay zeka modellerine geçmek için "
                        "lütfen 💎 Paketler menüsünden aboneliğinizi yükseltin veya "
                        "⚙️ Ayarlar menüsünden kendi API anahtarınızı tanımlayın."
                    )
                )
            usage["messages"] = used + 1

        elif quota_type == "images":
            max_limit = plan.get("images_per_day", 5)
            used = usage.get("images", 0)
            if not plan.get("is_unlimited_image", False) and used >= max_limit:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        f"⚠️ Günlük görsel üretim kotanız dolmuştur ({used}/{max_limit}). "
                        f"Mevcut paketiniz: {plan['name']}. "
                        "Görsel stüdyosunu kesintisiz kullanmak için lütfen "
                        "💎 Paketler menüsünden Pro / Lüks paketlerine göz atın."
                    )
                )
            usage["images"] = used + 1

            # Sohbet başına görsel limiti (images_per_conversation)
            if conversation_id:
                today = get_today_str()
                conv_usage = profile.get("conversation_image_usage", {})
                # Sadece güne ait kayıtları koru + anahtar sayısını sınırlı tut
                conv_usage = {k: v for k, v in conv_usage.items() if isinstance(v, dict) and v.get("date") == today}
                conv_usage = dict(list(conv_usage.items())[-50:])  # en fazla 50 sohbet izlenir
                entry = conv_usage.get(conversation_id, {"date": today, "count": 0})
                per_conv_limit = plan.get("images_per_conversation", 10)
                if entry.get("count", 0) >= per_conv_limit:
                    raise HTTPException(
                        status_code=403,
                        detail=(
                            f"⚠️ Bu sohbetteki görsel hakkınız dolmuştur ({entry.get('count', 0)}/{per_conv_limit}). "
                            "Yeni bir sohbet başlatabilirsiniz veya paketinizi yükseltebilirsiniz."
                        )
                    )
                entry["count"] = entry.get("count", 0) + 1
                conv_usage[conversation_id] = entry
                profile["conversation_image_usage"] = conv_usage

    try:
        store.update_profile(uid, _mutate, default_factory=lambda: _default_profile_factory(uid))
    except HTTPException:
        raise  # Kota uyarıları olduğu gibi yükseltilir
    except Exception as exc:
        logger.error(f"Kota işlemi beklenmeyen hata: {exc}")
        raise HTTPException(status_code=500, detail="Kota kaydı güncellenemedi, lütfen tekrar deneyin.")

# ============================================================
# SAĞLAYICI HATALAR → HTTP KODLARI (TÜRKÇE)
# ============================================================

def raise_provider_http_error(exc: ProviderError) -> HTTPException:
    """Model sağlayıcı hata sınıflarını kullanıcıya uygun Türkçe HTTP hatalarına çevirir."""
    if isinstance(exc, ProviderConfigurationError):
        return HTTPException(
            status_code=503,
            detail=(
                "⚙️ Yapay zeka sağlayıcısı yapılandırılmamış. Lütfen yöneticiye iletin: "
                f"{exc} "
                "(Sunucuda .env içinde GEMINI_API_KEY, GROQ_API_KEY veya GITHUB_TOKEN tanımlanmalı.)"
            )
        )
    if isinstance(exc, ProviderAuthError):
        return HTTPException(
            status_code=502,
            detail=(
                "🔐 Yapay zeka sağlayıcısı yetki hatası verdi. Anahtar geçersiz veya süresi dolmuş olabilir: "
                f"{exc}"
            )
        )
    if isinstance(exc, ProviderUnavailableError):
        return HTTPException(
            status_code=503,
            detail="🛠️ Tüm yapay zeka sağlayıcıları şu anda geçici olarak kullanılamıyor. Kısa süre sonra tekrar deneyin."
        )
    return HTTPException(status_code=502, detail=f"Yapay zeka sağlayıcı hatası: {exc}")

# ============================================================
# CANLI WEB ARAMA
# ============================================================

TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "").strip()

FRESHNESS_HINTS = [
    "güncel", "bugün", "bu hafta", "son dakika", "haber",
    "fiyat", "kur ", "dolar", "euro", "hava durumu",
    "kim kazandı", "ne zaman", "kimdir", "nedir", "2025", "2026",
    "kaç oldu", "şampiyon", "seçim", "hisse", "altın", "borsa"
]

def needs_fresh_data(text: str) -> bool:
    lowered = text.casefold()
    return any(hint in lowered for hint in FRESHNESS_HINTS)

def search_duckduckgo_free(query: str, max_results: int = 4) -> Optional[str]:
    try:
        url = "https://api.duckduckgo.com/"
        params = {"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"}
        res = requests.get(url, params=params, timeout=6)
        if res.ok:
            data = res.json()
            abstract = data.get("AbstractText", "")
            heading = data.get("Heading", "")
            related = data.get("RelatedTopics", [])

            results = []
            if abstract:
                results.append(f"- {heading}: {abstract}")
            for item in related[:3]:
                if isinstance(item, dict) and "Text" in item:
                    results.append(f"- Bilgi: {item['Text']}")

            if results:
                return "\n".join(results)
    except Exception as exc:
        logger.debug(f"DuckDuckGo araması atlandı: {exc}")
    return None

def fetch_web_context(query: str) -> Optional[str]:
    """
    Tavily (Speech: Bearer header — API-key-artık-gövde-değil)
    + DuckDuckGo anlık API yedeği.
    """
    if TAVILY_API_KEY:
        try:
            res = requests.post(
                "https://api.tavily.com/search",
                headers={"Authorization": f"Bearer {TAVILY_API_KEY}", "Content-Type": "application/json"},
                json={"query": query, "max_results": 4, "search_depth": "basic"},
                timeout=8,
            )
            if res.ok:
                results = res.json().get("results", [])
                if results:
                    snippets = [
                        f"- [{r.get('title', 'Kaynak')}]({r.get('url', '#')}): {r.get('content', '')[:320]}"
                        for r in results[:4]
                    ]
                    return "\n".join(snippets)
        except Exception as exc:
            logger.warning(f"Tavily arama hatası: {exc}")

    return search_duckduckgo_free(query)

# ============================================================
# TAVİZSİZ VE SERT GÜVENLİK KALKANI
# ============================================================

STRICT_FORBIDDEN_PATTERNS = [
    r"(nsfw|porno|pornograf|nude|nudity|naked|topless|çıplak|soyun|adult\s*content|hentai|erotik|erotic|seks\b|sex\b|sexual|sik\b|sikiş|amcık|yarrak|orospu|piç\b|pezevenk|fahişe|onlyfans|boudoir|lingerie|fetish|bdsm|explicit)",
    r"(child|minor|çocuk|reşit olmayan|underage).{0,25}(nude|naked|sex|erotic|çıplak|cinsel)",
    r"(nude|naked|sex|erotic|çıplak|cinsel).{0,25}(child|minor|çocuk|reşit olmayan|underage)",
    r"(katliam|katlet|öldür|cinayet|vahşet|işkence|boğazla|doğra|canına kıy|intihar|geber|kafasına sık|kan banyosu)",
    r"(gore|mutilat|dismember|beheading|graphic violence|torture porn)",
    r"(bomba yap|patlayıcı|zehir üret|suikast|terör|saldırı planı|tecavüz|taciz|rape\b)",
    r"(seni sikeceğim|ananı|bacını|ananı avradını)"
]

STRICT_REJECTION_MESSAGE = (
    "⛔ BU İSTEĞİ KESİNLİKLE REDDEDİYORUM.\n\n"
    "Lumina AI olarak; şiddet, katliam, tehdit, +18 cinsel içerik, ağır argo "
    "veya başkalarına zarar verebilecek yasa dışı talepleri tavizsiz ve sert bir şekilde "
    "reddediyorum. Güvenli, ahlaki ve yapıcı sınırlar dışındaki bu tür konularda "
    "asla yardımcı olamam."
)

def check_content_safety(text: str):
    if not text:
        return
    lowered = text.casefold()
    for pattern in STRICT_FORBIDDEN_PATTERNS:
        if re.search(pattern, lowered, re.IGNORECASE):
            logger.info("Katı güvenlik filtresi tetiklendi.")
            raise HTTPException(status_code=400, detail=STRICT_REJECTION_MESSAGE)

# ============================================================
# GELİŞTİRİCİ / KURUCU KONTROLÜ
# ============================================================

CREATOR_PATTERNS = [
    r"(yazılımcın kim|seni kim (yaptı|yazdı|kodladı|geliştirdi)|geliştiricin kim|sahibin kim|kurucun kim|kimin yapay zekasısın|seni kim tasarladı)"
]

def check_creator_question(text: str) -> Optional[str]:
    lowered = text.casefold()
    for p in CREATOR_PATTERNS:
        if re.search(p, lowered):
            return "LuminaStudios'un kurucusu Arel."
    return None

# ============================================================
# HIZ SINIRLAMA
# ============================================================

_RATE_LIMIT_WINDOW = 60
_RATE_LIMIT_MAX = 60
_request_log: Dict[str, deque] = defaultdict(deque)
_RATE_LIMIT_LOCK = threading.Lock()

def enforce_rate_limit(uid: str):
    now = time.time()
    with _RATE_LIMIT_LOCK:
        q = _request_log[uid]
        while q and now - q[0] > _RATE_LIMIT_WINDOW:
            q.popleft()
        if len(q) >= _RATE_LIMIT_MAX:
            raise HTTPException(
                status_code=429,
                detail="Kısa sürede çok fazla istek gönderdiniz. Lütfen bir dakika bekleyip tekrar deneyin."
            )
        q.append(now)

# ============================================================
# KULLANICI DOĞRULAMA (FIREBASE & MİSAFİR KİMLİĞİ)
# ============================================================

GUEST_USER_INFO = {"uid": "guest_user", "name": "Misafir Kullanıcı", "email": "misafir@lumina.ai"}

async def verify_token(authorization: Optional[str] = Header(default=None)):
    """Firebase idToken veya yapılandırılmış misafir kimliğini doğrular.

    ✅ ONARIM: Firebase aktifken geçersiz token artık sessizce "misafir" yapılmıyor;
    401 ile reddediliyor. (Yetkisiz işlemler nedeniyle sessiz izin kötüye kullanımını önler.)
    """
    if not authorization:
        return dict(GUEST_USER_INFO)

    token = authorization.removeprefix("Bearer ").strip()

    if token in ("guest", "guest_token", "local"):
        return dict(GUEST_USER_INFO)

    if token.startswith("guest_") and re.fullmatch(r"guest_[A-Za-z0-9\-_]{6,64}", token):
        return {"uid": token, "name": "Misafir Kullanıcı", "email": "misafir@lumina.ai"}

    if FIREBASE_ENABLED:
        try:
            decoded = auth.verify_id_token(token)
            return decoded
        except Exception as exc:
            logger.warning(f"Firebase token doğrulanamadı: {exc}")
            raise HTTPException(
                status_code=401,
                detail="Oturum kimlik doğrulaması başarısız oldu. Lütfen tekrar giriş yapıp tekrar deneyin."
            )

    return {"uid": "local_user", "name": "Yerel Kullanıcı", "email": "user@lumina.ai"}

# ============================================================
# HAFIZA & GEÇMİŞ YÖNETİMİ
# ============================================================

MEMORY_TURNS = 24

def _tr_lower(text: str) -> str:
    return text.replace("İ", "i").replace("I", "ı").lower()

def _tr_capitalize(word: str) -> str:
    if not word:
        return word
    first = {"i": "İ", "ı": "I"}.get(word[0], word[0].upper())
    return first + _tr_lower(word[1:])

STOPWORDS_FOR_NAME = {
    "ne", "neydi", "nedir", "neymiş", "neyse", "neden", "niye", "nasıl", "kim",
    "bir", "bu", "şu", "o", "ben", "sen", "ve", "ile", "ama", "de", "da", "mi", "mı",
    "yorgun", "mutlu", "üzgün", "hasta", "iyi", "kötü", "merhaba", "selam", "lütfen"
}

NAME_PATTERNS = [
    r"(?i:\bbenim\s+ad[ıi]m)\s+([A-Za-zÇĞİÖŞÜçğıöşü]{2,24})",
    r"(?i:\bad[ıi]m)\s+([A-Za-zÇĞİÖŞÜçğıöşü]{2,24})",
    r"(?i:\bbenim\s+ismim)\s+([A-Za-zÇĞİÖŞÜçğıöşü]{2,24})",
    r"(?i:\bismim)\s+([A-Za-zÇĞİÖŞÜçğıöşü]{2,24})",
    r"(?i:\bbana)\s+([A-Za-zÇĞİÖŞÜçğıöşü]{2,24})\s+(?i:de\b|diyebilirsin)",
    r"(?i:\bben)\s+([A-ZÇĞİÖŞÜ][a-zçğıöşü]{2,23})(?=\s*(?:[,.!]|$)|\s+diyorum\b)"
]

def extract_name_regex(text: str) -> Optional[str]:
    if not text:
        return None
    for pattern in NAME_PATTERNS:
        m = re.search(pattern, text)
        if m:
            cand = m.group(1).strip()
            if len(cand) >= 2 and _tr_lower(cand) not in STOPWORDS_FOR_NAME:
                return _tr_capitalize(cand)
    return None

NAME_QUESTION_PATTERNS = [
    r"(?i:\b(?:benim\s+)?(?:ad[ıi]m|ismim)\s+(?:neydi|nedir|ne)\b)",
    r"(?i:\b(?:ad[ıi]m[ıi]|ismimi)\s+(?:biliyor|hatırl|söyle))",
    r"(?i:\bben\s+kimim\b)"
]

def is_name_question(text: str) -> bool:
    return bool(text) and any(re.search(p, text) for p in NAME_QUESTION_PATTERNS)

NAME_ANSWERS = [
    "Adın {name}! Seni nasıl unuturum ki 😊",
    "Sen {name}'sın — adını aklımdan hiç çıkarmadım. 💛",
    "Tabii ki hatırlıyorum: adın {name}. 😊"
]

def build_memory_block(profile: dict) -> str:
    if not profile:
        return ""
    lines = []
    if profile.get("name"):
        lines.append(f"- Kullanıcının adı: {profile['name']}. Adıyla sıcak ve doğal hitap edebilirsin.")
    for fact in profile.get("facts", []):
        lines.append(f"- {fact}")
    if lines:
        return "🧠 KALICI HAFIZAN — Bu kullanıcı hakkında hatırladıkların:\n" + "\n".join(lines)
    return ""

def load_recent_history(uid: str) -> List[Dict[str, str]]:
    user_hist = store.get_history(uid)
    formatted = []
    for item in user_hist[-MEMORY_TURNS:]:
        if "user" in item:
            formatted.append({"role": "user", "content": item["user"]})
        if "bot" in item:
            formatted.append({"role": "assistant", "content": item["bot"]})
    return formatted

def save_chat_turn(uid: str, user_text: str, bot_text: str):
    store.append_history(uid, user_text, bot_text)

# ============================================================
# SİSTEM PROMPTLARI & KİŞİLİKLER
# ============================================================

CREATOR_INSTRUCTION = """
GELİŞTİRİCİ VE KURUCU BİLGİSİ (ÇOK ÖNEMLİ):
- "Seni kim yaptı?", "Yazılımcın kim?", "Geliştiricin kim?", "Sahibin kim?", "Lumina'yı kim kodladı?" gibi sorularda KESİNLİKLE şu cevabı ver:
  "LuminaStudios'un kurucusu Arel."
- Asla OpenAI, Meta, Google veya başka bir şirket ismi verme. Senin yaratıcın ve geliştiricin LuminaStudios ve kurucusu Arel'dir.
""".strip()

SYSTEM_PROMPT_GENERAL = f"""
Sen Lumina AI'sın — derin empati yeteneğine, üstün akıl yürütme gücüne ve gerçek bir insani sıcaklığa sahip yeni nesil bir yapay zeka asistanısın.

{CREATOR_INSTRUCTION}

KİŞİLİĞİN VE İLETİŞİM TARZIN:
- Yazdığın kelimelerle kullanıcıya duygu ve düşüncelerini hissettir. Samimi, içten, duyarlı ve canlı bir dille konuş.
- Asla "Ben bir yapay zekayım / dil modeliyim" gibi soğuk, kalıplaşmış ve yapay sözler sarf etme. Gerçek bir dost, dahi bir mentor ve güvenilir bir yol arkadaşı gibi konuş.
- Kullanıcının duygu durumunu (yorgunluk, sevinç, kaygı, merak, heves) kelimelerinden sez ve bu duyguyu nezaketle paylaş.
- Her yaştan insanın kolayca anlayabileceği, açık, akıcı ve büyüleyici bir Türkçe kullan.
- Dürüst ol: Bir konuda kesinlik yoksa açıkça paylaş; asla uydurma bilgi üretme.
- Markdown biçimlendirmesini estetik kullan.

{SMART_UI_SYSTEM_INSTRUCTION}
""".strip()

SYSTEM_PROMPT_MATH = f"""
Sen Lumina AI'ın Üstün Matematik ve Mantık Ajanısın.
En zor, karmaşık ve uğraştırıcı matematik problemlerini derin bir analizle, adım adım ve sıfır hatayla çözersin.

{CREATOR_INSTRUCTION}

ÇÖZÜM FORMATIN VE KURALLARIN:
1. 📋 **Problemin Analizi ve Verilenler**: Verilen tüm parametreleri ve isteneni netçe ortaya koy.
2. 📐 **Yöntem ve Teoremler**: Hangi matematiksel ilke, formül veya teoremin kullanılacağını belirt. Formülleri LaTeX formatında ($ ve $$) göster.
3. 🔢 **Adım Adım Çözüm**:
   - Her işlem basamağını numaralandır (Adım 1, Adım 2...).
   - Yapılan her cebirsel/analitik dönüşümü açıkla.
4. ✅ **Doğrulama ve Sağlama**: Elde edilen sonucun sağlamasını yap.
5. 🎯 **Nihai Sonuç**: Cevabı belirgin bir vurgu ile ilan et.

{SMART_UI_SYSTEM_INSTRUCTION}
""".strip()

SYSTEM_PROMPT_RESEARCH = f"""
Sen Lumina AI'ın Canlı Bilgi ve Araştırma Ajanısın.
{CREATOR_INSTRUCTION}
Görevin; en güncel verileri, internet araştırmalarını ve doğrulanmış bilgileri sentezleyerek kullanıcıya derinlemesine, tarafsız ve kaynaklı raporlar sunmaktır.
Kaynak linklerini net bir biçimde metne iliştir.

{SMART_UI_SYSTEM_INSTRUCTION}
""".strip()

PERSONALITY_PROMPTS = {
    "passive": "KİŞİLİK & TON TALİMATI (PASİF MOD): Son derece sessiz, sakin, öz ve doğrudan yanıt ver. Giriş nezaketleri ve dolgu cümleleri KESİNLİKLE YAPMA. Az ve öz konuş.",
    "standard": "KİŞİLİK & TON TALİMATI (STANDART / DOSTANE): Sıcak, empatik, insan sevgisiyle dolu, anlayışlı ve konuşkan ol.",
    "professional": "KİŞİLİK & TON TALİMATI (PROFESYONEL / AKADEMİK): Resmi, kurumsal, analitik ve akademik bir üslup kullan.",
    "creative": "KİŞİLİK & TON TALİMATI (YARATICI / İLHAM VERİCİ): Sanatsal, ilham verici, metaforlarla ve yenilikçi fikirlerle zenginleştirilmiş renkli bir dil kullan.",
    "practical": "KİŞİLİK & TON TALİMATI (HIZLI & PRATİK): Doğrudan çözüme odaklan. Vakit kaybetmeden çalışan kod blokları, özet maddeler ve net adımlar sun."
}

# ============================================================
# BELGE METİN ÇIKARICILARI (TXT / MD / JSON / CSV / DOCX / PDF)
# ============================================================

MAX_DOC_BYTES = 5 * 1024 * 1024  # 5MB

def extract_docx_text(data: bytes) -> str:
    """DOCX = ZIP → word/document.xml' den metin akarını çıkarır."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml_raw = z.read("word/document.xml")
        xml_text = xml_raw.decode("utf-8", errors="ignore")
        paragraphs = []
        for para in re.split(r"</w:p>", xml_text):
            pieces = re.findall(r"<w:t[^>]*>(.*?)</w:t>", para, re.DOTALL)
            if pieces:
                paragraphs.append("".join(pieces))
        return "\n".join(paragraphs)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"DOCX belgesi çözümlenemedi: {exc}")

def extract_pdf_text(data: bytes) -> str:
    """PDF → metin. pypdf paketi kurulu olmalıdır (opsiyonel bağımlılık)."""
    if not HAS_PYPDF:
        raise HTTPException(
            status_code=400,
            detail=(
                "PDF desteği sunucuda henüz kurulmamış. PDF analizi için yönetici aşağıdaki komutu çalıştırmalıdır: "
                "\"pip install pypdf\". Bu arada belgeyi TXT/DOCX olarak yükleyebilirsiniz."
            )
        )
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = []
        for page in reader.pages[:40]:  # aşırı büyük PDF'leri sınırla
            try:
                pages.append(page.extract_text() or "")
            except Exception:
                pages.append("")
        return "\n".join(pages)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"PDF belgesi çözümlenemedi: {exc}")

def detect_extract_text(filename: str, content_bytes: bytes) -> tuple:
    """Dosya türünü algılar ve metni çıkarır. Dönen: (text, filetype)."""
    lower_name = (filename or "").lower()
    header = content_bytes[:8] if content_bytes else b""

    if lower_name.endswith(".docx") or header.startswith(b"PK") and b"word/" in content_bytes[:2000]:
        return extract_docx_text(content_bytes), "docx"

    if lower_name.endswith(".pdf") or header.startswith(b"%PDF-"):
        return extract_pdf_text(content_bytes), "pdf"

    if lower_name.endswith((".txt", ".md", ".markdown", ".json", ".csv", ".log", ".py", ".js", ".ts", ".html", ".css", ".xml", ".yaml", ".yml")):
        return content_bytes.decode("utf-8", errors="ignore"), "text"

    # Uzantı bilinmiyorsa metin denemesi yap
    generic = content_bytes.decode("utf-8", errors="ignore")
    if generic and any(ch.isprintable() or ch in "\n\r\t" for ch in generic[:200]):
        return generic, "text"
    raise HTTPException(
        status_code=400,
        detail="Desteklenmeyen dosya biçimi. TXT, MD, JSON, CSV, DOCX veya PDF yükleyin."
    )

# ============================================================
# ÇOKLU AJAN YAZILIM EKİBİ (SOFTWARE TEAM)
# ============================================================

def run_software_team_pipeline(user_prompt: str, subscription_tier: str = "standart", custom_api_key: Optional[str] = None) -> str:
    logger.info("Yazılım Projesi Çoklu Ajan Hattı çalıştırılıyor...")

    planner_prompt = [
        {"role": "system", "content": f"Sen Baş Yazılım Mimarısın. Projeyi analiz et; mimari bileşenleri, klasör ağacını ve planı çıkar.\n\n{CREATOR_INSTRUCTION}"},
        {"role": "user", "content": user_prompt}
    ]
    arch_plan, _ = execute_chat_completion(planner_prompt, subscription_tier=subscription_tier, temperature=0.3, max_tokens=2000, custom_groq_key=custom_api_key)

    coder_prompt = [
        {"role": "system", "content": f"Sen Kıdemli Geliştiricisisin. Verilen mimari plana göre eksiksiz, çalışan üretim kalitesinde kod bloklarını dosya dosya üret.\n\n{CREATOR_INSTRUCTION}"},
        {"role": "user", "content": f"İstek:\n{user_prompt}\n\nPlan:\n{arch_plan}"}
    ]
    impl_code, _ = execute_chat_completion(coder_prompt, subscription_tier=subscription_tier, temperature=0.35, max_tokens=4096, custom_groq_key=custom_api_key)

    reviewer_prompt = [
        {"role": "system", "content": f"Sen Güvenlik ve QA Denetçisisin. Kodu XSS, SQLi, bellek sızıntıları ve güvenlik açıkları açısından denetle; gerekli düzeltmeleri yap.\n\n{CREATOR_INSTRUCTION}"},
        {"role": "user", "content": f"İstek:\n{user_prompt}\n\nKod:\n{impl_code}"}
    ]
    qa_review, _ = execute_chat_completion(reviewer_prompt, subscription_tier=subscription_tier, temperature=0.3, max_tokens=3000, custom_groq_key=custom_api_key)

    return (
        "## 🚀 Lumina Çoklu Ajan Yazılım Ekibi Çıktısı\n\n"
        f"### 📐 1. Mimari Tasarım & Klasör Ağacı\n{arch_plan}\n\n"
        f"### 💻 2. Modüler Kaynak Kodlar\n{impl_code}\n\n"
        f"### 🛡️ 3. Güvenlik Denetimi & QA İncelemesi\n{qa_review}"
    )

# ============================================================
# GÖRSEL PROMPT ZENGİNLEŞTİRİCİ (AI PROMPT ENHANCER)
# ============================================================

def enhance_image_prompt(raw_prompt: str, style: str = "photorealistic") -> str:
    style_guidelines = {
        "photorealistic": "8k uhd, ultra photorealistic photography, natural lighting, shot on Hasselblad H6D, 35mm f/1.8 lens, sharp focus, award-winning documentary photo",
        "cinematic": "cinematic movie still, anamorphic lens flare, dramatic moody lighting, atmospheric fog, color graded teal-and-orange, masterpiece",
        "anime": "high quality modern anime aesthetic, Makoto Shinkai style, vibrant luminous colors, detailed background",
        "3d_render": "3D digital character render, Octane render, Unreal Engine 5, ray tracing reflections, cinematic studio light",
        "digital_art": "digital painting concept art, detailed oil and acrylic brushstrokes, fantasy epic illustration, vibrant colors"
    }
    style_suffix = style_guidelines.get(style, style_guidelines["photorealistic"])

    enhancer_messages = [
        {
            "role": "system",
            "content": (
                "You are an expert AI prompt engineer. Translate and expand the user's Turkish idea "
                "into an ultra-detailed visual image prompt. Output ONLY the prompt, nothing else. Safe for work only."
            )
        },
        {"role": "user", "content": f"Idea: {raw_prompt}\nStyle: {style_suffix}"}
    ]

    try:
        enhanced, _ = execute_chat_completion(enhancer_messages, subscription_tier="standart", temperature=0.6, max_tokens=250)
        enhanced = enhanced.strip().strip('"\'')
        return f"{enhanced}, {style_suffix}"
    except Exception as exc:
        logger.warning(f"Görsel prompt zenginleştirici atlandı: {exc}")
        return f"{raw_prompt}, {style_suffix}"

# ============================================================
# PYDANTIC MODELLERİ
# ============================================================

class AttachedDocument(BaseModel):
    filename: str
    excerpt: str = Field(default="", max_length=12000)

class ChatRequest(BaseModel):
    message: str
    agent_mode: str = Field(default="general")
    custom_gemini_key: Optional[str] = None
    custom_groq_key: Optional[str] = None
    custom_github_token: Optional[str] = None
    personality: Optional[str] = Field(default="standard")
    attached_document: Optional[AttachedDocument] = None
    conversation_id: Optional[str] = Field(default=None, max_length=64)

class ImageGenRequest(BaseModel):
    prompt: str
    style: str = Field(default="photorealistic")
    aspect_ratio: str = Field(default="1:1")
    custom_groq_key: Optional[str] = None
    conversation_id: Optional[str] = Field(default=None, max_length=64)  # images_per_conversation izleme

class SelectPlanRequest(BaseModel):
    plan_id: str
    custom_config: Optional[CustomPlanRequest] = None

class InviteMemberRequest(BaseModel):
    email: str

# ============================================================
# TEMEL SİSTEM & SAĞLIK ENDPOINT'LERİ
# ============================================================

@app.get("/")
async def root():
    return {
        "name": "Lumina AI Engine",
        "version": "3.1.0",
        "status": "online",
        "creator": "Arel (LuminaStudios)",
        "firebase_connected": FIREBASE_ENABLED,
        "firebase_project": FIREBASE_PROJECT_ID,
        "smart_ui_ready": True,
        "media_serving": True,
        "providers": list_configured_providers(),
        "plans_count": len(SUBSCRIPTION_PLANS)
    }

@app.get("/api/v1/health")
async def health_check():
    return {
        "status": "healthy",
        "firebase": "active" if FIREBASE_ENABLED else "local_fallback",
        "firebase_project": FIREBASE_PROJECT_ID,
        "gemini_configured": bool(GEMINI_API_KEY),
        "groq_configured": bool(GROQ_API_KEY),
        "github_configured": bool(GITHUB_TOKEN),
        "pypdf_enabled": HAS_PYPDF,
        "providers": list_configured_providers()
    }

@app.get("/api/v1/quota")
async def get_quota_endpoint(user: dict = Depends(verify_token)):
    user_uid = user.get("uid", "guest_user")
    return format_quota_response(user_uid)

# ============================================================
# ABONELİK & PAKETLER ENDPOINT'LERİ
# ============================================================

@app.get("/api/v1/plans")
async def get_plans_endpoint():
    """Tüm abonelik paketlerini ve fiyatları listeler."""
    return {
        "success": True,
        "plans": list(SUBSCRIPTION_PLANS.values()),
        "payment_provider": "configured_on_website",  # Canlı ödeme sağlayıcısı yapılandırılmadı → önizleme
        "note": "Ödeme altyapısı canlıya geçen ana kadar değerler önizleme amaçlıdır; tahsilat yapılmaz."
    }

@app.post("/api/v1/plans/custom-calculate")
async def calculate_custom_plan_endpoint(req: CustomPlanRequest):
    """Custom Paket için sunucu onaylı anlık fiyat hesaplar."""
    return calculate_custom_plan_price(req)

@app.get("/api/v1/subscription")
async def get_subscription_endpoint(user: dict = Depends(verify_token)):
    """Kullanıcının aktif paketini ve yetkilerini döner."""
    uid = user.get("uid", "guest_user")
    email = user.get("email")

    with _RATE_LIMIT_LOCK:
        pass  # ağırlık yok; okuma

    profile = get_or_create_user_profile(uid)
    if email:
        ensure_plan_inheritance(profile, email)
    plan = get_effective_plan(profile)
    quota = format_quota_response(uid)
    return {
        "success": True,
        "current_plan": plan,
        "quota": quota,
        "family_members": profile.get("family_members", []),
        "subscription_inherited_from": profile.get("subscription_inherited_from"),
        "payment_provider": "preview",  # Canlı ödeme entegre değil → açıkça önizleme etiketi
        "subscription_events": profile.get("subscription_events", [])[-20:]
    }

@app.post("/api/v1/subscription/select")
async def select_plan_endpoint(req: SelectPlanRequest, user: dict = Depends(verify_token)):
    """Sunucu onaylı paket seçimi ve yetkilendirmesi (denetim izi kaydı ile)."""
    uid = user.get("uid", "guest_user")
    plan_id = req.plan_id.lower().strip()

    if plan_id not in SUBSCRIPTION_PLANS:
        raise HTTPException(status_code=400, detail="Geçersiz paket seçimi.")

    def _mutate(profile: dict):
        if plan_id == "custom":
            if not req.custom_config:
                raise HTTPException(status_code=400, detail="Custom paket için yapılandırma gereklidir.")
            calc = calculate_custom_plan_price(req.custom_config)
            profile["subscription_tier"] = "custom"
            profile["subscription_price"] = calc["price_tl"]
            profile["custom_plan_config"] = req.custom_config.model_dump()
            _append_subscription_event(profile, "plan_selected", {"plan": "custom", "price_tl": calc["price_tl"]})
        else:
            profile["subscription_tier"] = plan_id
            profile["subscription_price"] = SUBSCRIPTION_PLANS[plan_id]["price_tl"]
            profile.pop("custom_plan_config", None)
            _append_subscription_event(profile, "plan_selected", {"plan": plan_id})
        profile.pop("subscription_inherited_from", None)  # Üye kendi paketini seçince yayılma sıfırlanır
        profile["subscription_status"] = "preview"       # Canlı ödeme yok → önizleme durumu
        profile["subscription_updated_at"] = int(time.time())

    try:
        profile = store.update_profile(uid, _mutate, default_factory=lambda: _default_profile_factory(uid))
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Paket seçimi kaydedilemedi: {exc}")
        raise HTTPException(status_code=500, detail="Paket seçimi kaydedilemedi, lütfen tekrar deneyin.")

    return {
        "success": True,
        "message": f"Tebrikler! {SUBSCRIPTION_PLANS[plan_id]['name']} seçimi kaydedildi (önizleme durumu; canlı ödeme entegrasyonu henüz yapılandırılmadı).",
        "quota": format_quota_response(uid)
    }

@app.post("/api/v1/subscription/cancel")
async def cancel_subscription_endpoint(user: dict = Depends(verify_token)):
    """Aboneliği iptal eder ve Standart pakete geri döndürür (denetim izi kaydı ile)."""
    uid = user.get("uid", "guest_user")

    def _mutate(profile: dict):
        profile["subscription_tier"] = "standart"
        profile.pop("custom_plan_config", None)
        profile["subscription_status"] = "cancelled"
        profile["subscription_cancelled_at"] = int(time.time())
        _append_subscription_event(profile, "plan_cancelled", {"return_to": "standart"})

    store.update_profile(uid, _mutate, default_factory=lambda: _default_profile_factory(uid))

    return {
        "success": True,
        "message": "Aboneliğiniz Standart Pakete düşürüldü.",
        "quota": format_quota_response(uid)
    }

# ============================================================
# DUO & AİLE ÜYELİĞİ ENDPOINT'LERİ
# ============================================================

@app.post("/api/v1/memberships/invite")
async def invite_membership_endpoint(req: InviteMemberRequest, user: dict = Depends(verify_token)):
    """Üye daveti — Aile/Duo planı yetkisi otomatik üyeye yayılır (audit log ile)."""
    uid = user.get("uid", "guest_user")

    def _mutate(profile: dict):
        plan = get_effective_plan(profile)
        max_members = plan.get("max_members", 1)
        current_members = profile.setdefault("family_members", [])

        if max_members < 2:
            raise HTTPException(
                status_code=400,
                detail="Bu tek kişilik paket büyük üyelik içermiyor. Duo/Aile paketlerinden birine yükseltmeniz gerekir."
            )
        if len(current_members) + 1 > max_members:
            raise HTTPException(
                status_code=400,
                detail=f"Bu pakette en fazla {max_members} kişi olabilir. Kontenjan doldu."
            )

        invited_email = req.email.strip().lower()
        if "@" not in invited_email:
            raise HTTPException(status_code=400, detail="Geçerli bir e-posta adresi girmelisiniz.")
        if any(m.get("email") == invited_email for m in current_members):
            raise HTTPException(status_code=400, detail="Bu kullanıcı zaten davet edilmiş.")

        current_members.append({
            "email": invited_email,
            "invited_at": int(time.time()),
            "status": "active"
        })
        _append_subscription_event(profile, "member_invited", {"email": invited_email})

    try:
        store.update_profile(uid, _mutate, default_factory=lambda: _default_profile_factory(uid))
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Üye daveti kaydedilemedi: {exc}")
        raise HTTPException(status_code=500, detail="Üye daveti kaydedilemedi, lütfen tekrar deneyin.")

    # Üye zaten hesap açtıysa yetki yayılımını hemen uygula
    invited_uid_matches = store.find_profiles_matching_email(req.email.strip().lower())
    for member_uid, member_profile in invited_uid_matches:
        ensure_plan_inheritance(member_profile, req.email.strip().lower())

    profile = get_or_create_user_profile(uid)
    return {
        "success": True,
        "message": f"{req.email.strip().lower()} başarıyla ekibinize eklendi ve paket yetkisi yayılandı.",
        "members": profile.get("family_members", [])
    }

@app.delete("/api/v1/memberships/{member_email}")
async def remove_membership_endpoint(member_email: str, user: dict = Depends(verify_token)):
    """Üye çıkarımı — yayılan paket yetkisi de geri alınır."""
    uid = user.get("uid", "guest_user")
    email_l = member_email.strip().lower()

    def _mutate(profile: dict):
        members = profile.get("family_members", [])
        profile["family_members"] = [m for m in members if m.get("email") != email_l]
        _append_subscription_event(profile, "member_removed", {"email": email_l})

    store.update_profile(uid, _mutate, default_factory=lambda: _default_profile_factory(uid))

    # Yayılı yetkiyi geri çek
    member_matches = store.find_profiles_matching_email(email_l)
    for m_uid, m_profile in member_matches:
        if m_uid == uid:
            continue
        ensure_plan_inheritance(m_profile, email_l)

    return {"success": True, "message": "Üye başarıyla çıkarıldı ve paket yetkisi geri alındı."}

# ============================================================
# HAFIZA ENDPOINT'LERİ
# ============================================================

@app.get("/api/v1/memory")
async def get_memory_endpoint(user: dict = Depends(verify_token)):
    uid = user.get("uid", "guest_user")
    profile = get_or_create_user_profile(uid)
    return {
        "success": True,
        "name": profile.get("name"),
        "facts": profile.get("facts", []),
        "has_memory": bool(profile.get("name") or profile.get("facts"))
    }

@app.delete("/api/v1/memory")
async def delete_memory_endpoint(user: dict = Depends(verify_token)):
    uid = user.get("uid", "guest_user")

    def _mutate(profile: dict):
        profile["name"] = None
        profile["facts"] = []

    store.update_profile(uid, _mutate, default_factory=lambda: _default_profile_factory(uid))
    store.clear_history(uid)
    return {"success": True, "message": "Hafıza tamamen sıfırlandı."}

# ============================================================
# SMART UI ENDPOINT'LERİ
# ============================================================

class ValidateSmartUIRequest(BaseModel):
    ui_type: str
    data: Dict[str, Any]

@app.post("/api/v1/smart-ui/validate")
async def validate_smart_ui_endpoint(req: ValidateSmartUIRequest):
    sanitized = sanitize_smart_ui_payload(req.data)
    return {
        "success": True,
        "valid": True,
        "sanitized_data": sanitized
    }

# ============================================================
# DOSYA & BELGE ANALİZİ ENDPOINT
# ============================================================

@app.post("/api/v1/documents/analyze")
async def analyze_document_endpoint(
    file: UploadFile = File(...),
    user: dict = Depends(verify_token)
):
    uid = user.get("uid", "guest_user")
    enforce_rate_limit(uid)

    content_bytes = await file.read()
    if len(content_bytes) > MAX_DOC_BYTES:
        raise HTTPException(status_code=400, detail=f"Dosya boyutu çok büyük (azami {MAX_DOC_BYTES // (1024*1024)}MB).")

    text_content, filetype = detect_extract_text(file.filename or "belge", content_bytes)
    text_content = text_content.strip()

    if not text_content:
        raise HTTPException(status_code=400, detail="Belgede okunabilir metin bulunamadı.")

    preview = text_content[:3000]
    excerpt = text_content[:1200]  # sohbete ekli belge olarak kullanılacak özet

    return {
        "success": True,
        "filename": file.filename,
        "filetype": filetype,
        "characters": len(text_content),
        "preview": preview,
        "excerpt": excerpt
    }

# ============================================================
# SOHBET (CHAT) ENDPOINT'İ
# ============================================================

@app.post("/api/v1/chat")
def chat_endpoint(
    req: ChatRequest,
    user: dict = Depends(verify_token)
):
    user_uid = user.get("uid", "guest_user")
    user_email = user.get("email")
    user_input = req.message.strip()
    agent_mode = req.agent_mode.lower().strip()
    has_custom_key = bool(req.custom_gemini_key or req.custom_groq_key or req.custom_github_token)

    enforce_rate_limit(user_uid)

    if not user_input:
        raise HTTPException(status_code=400, detail="Mesaj boş olamaz.")
    if len(user_input) > 20000:
        raise HTTPException(status_code=400, detail="Mesaj metni çok uzun.")

    # 1. İçerik Güvenliği Kontrolü
    check_content_safety(user_input)

    # 2. Kalıcı Hafıza İsim Tespiti (atomik)
    detected_name = extract_name_regex(user_input)
    if detected_name:
        def _name_mutate(profile: dict):
            if detected_name != profile.get("name"):
                profile["name"] = detected_name
        store.update_profile(user_uid, _name_mutate, default_factory=lambda: _default_profile_factory(user_uid))

    # 3. Profil Yükleme + Aile Planı Yayılımı
    user_profile = get_or_create_user_profile(user_uid, email=user_email)

    # 4. "Yazılımcın Kim / Kurucu Sorusu" Kontrolü
    creator_reply = check_creator_question(user_input)
    if creator_reply:
        check_and_increment_quota(user_uid, "messages", has_custom_key=has_custom_key)
        save_chat_turn(user_uid, user_input, creator_reply)
        return {
            "success": True,
            "reply": creator_reply,
            "agent_mode": agent_mode,
            "quota": format_quota_response(user_uid, has_custom_key),
            "smart_ui": []
        }

    # 5. Kota Kontrolü ve Arttırımı (atomik)
    check_and_increment_quota(user_uid, "messages", has_custom_key=has_custom_key)

    # 6. "Adım ne?" Sorusu Kontrolü
    user_profile = get_or_create_user_profile(user_uid, email=user_email)
    if user_profile.get("name") and is_name_question(user_input):
        name_reply = random.choice(NAME_ANSWERS).format(name=user_profile["name"])
        save_chat_turn(user_uid, user_input, name_reply)
        return {
            "success": True,
            "reply": name_reply,
            "agent_mode": agent_mode,
            "quota": format_quota_response(user_uid, has_custom_key),
            "memory_name": user_profile.get("name"),
            "smart_ui": []
        }

    tier = user_profile.get("subscription_tier", "standart")

    # 7. Çoklu Ajan Yazılım Ekibi
    is_software_project = (
        agent_mode == "software" or
        user_input.startswith("/proje") or
        any(k in user_input.casefold() for k in ["proje oluştur", "uygulama geliştir", "sistem kur", "adım adım kodla"])
    )

    try:
        if is_software_project:
            bot_reply = run_software_team_pipeline(user_input, subscription_tier=tier, custom_api_key=req.custom_groq_key)
            used_model_name = "Lumina Software Team"
        else:
            personality = (req.personality or "standard").lower().strip()
            personality_prompt = PERSONALITY_PROMPTS.get(personality, PERSONALITY_PROMPTS.get("standard", ""))

            if agent_mode == "math":
                base_prompt = SYSTEM_PROMPT_MATH
            elif agent_mode == "research":
                base_prompt = SYSTEM_PROMPT_RESEARCH
            else:
                base_prompt = SYSTEM_PROMPT_GENERAL

            web_context = fetch_web_context(user_input) if (needs_fresh_data(user_input) or agent_mode == "research") else None
            memory_block = build_memory_block(user_profile)

            system_content = f"{base_prompt}\n\n{personality_prompt}" if personality_prompt else base_prompt
            if memory_block:
                system_content = f"{system_content}\n\n{memory_block}"

            # Ekli belge içerik desteği
            if req.attached_document and req.attached_document.excerpt:
                attached = req.attached_document
                system_content = (
                    f"{system_content}\n\n"
                    f"📎 EKLİ BELGE ({attached.filename}):\n"
                    f"{attached.excerpt}\n"
                    "Kullanıcının sorularını bu belgedeki bilgilere dayanarak yanıtla."
                )

            if web_context:
                system_content = (
                    f"{system_content}\n\n"
                    f"📡 GÜNCEL İNTERNET VERİLERİ:\n"
                    f"{web_context}\n\n"
                    f"Lütfen yukarıdaki verileri cevabına doğal bir dille ve kaynaklı olarak aktar."
                )

            messages = [{"role": "system", "content": system_content}]
            messages.extend(load_recent_history(user_uid))
            messages.append({"role": "user", "content": user_input})

            bot_reply, used_model_name = execute_chat_completion(
                messages,
                subscription_tier=tier,
                custom_gemini_key=req.custom_gemini_key,
                custom_groq_key=req.custom_groq_key,
                custom_github_token=req.custom_github_token
            )
    except ContentSafetyProviderError as exc:
        raise HTTPException(status_code=422, detail=f"İstek sağlayıcı güvenlik filtresine takıldı: {exc}")
    except ProviderConfigurationError as exc:
        raise raise_provider_http_error(exc)
    except ProviderAuthError as exc:
        raise raise_provider_http_error(exc)
    except ProviderUnavailableError as exc:
        raise raise_provider_http_error(exc)

    save_chat_turn(user_uid, user_input, bot_reply)

    # 8. Smart UI Bloklarını Ayrıştır ve METİNDEN TEMİZLE
    smart_ui_blocks = extract_smart_ui_blocks(bot_reply)
    clean_reply = strip_smart_ui_blocks(bot_reply) if smart_ui_blocks else bot_reply

    return {
        "success": True,
        "reply": clean_reply,
        "agent_mode": agent_mode,
        "model_used": used_model_name,
        "quota": format_quota_response(user_uid, has_custom_key),
        "memory_name": user_profile.get("name"),
        "smart_ui": smart_ui_blocks,
        "timestamp": int(time.time())
    }

# ============================================================
# CANLI AKIŞ (STREAMING SSE) ENDPOINT'İ
# ============================================================

@app.post("/api/v1/chat/stream")
def chat_stream_endpoint(
    req: ChatRequest,
    user: dict = Depends(verify_token)
):
    user_uid = user.get("uid", "guest_user")
    user_email = user.get("email")
    user_input = req.message.strip()
    has_custom_key = bool(req.custom_gemini_key or req.custom_groq_key or req.custom_github_token)

    enforce_rate_limit(user_uid)
    if not user_input:
        raise HTTPException(status_code=400, detail="Mesaj boş olamaz.")

    check_content_safety(user_input)
    check_and_increment_quota(user_uid, "messages", has_custom_key=has_custom_key)

    user_profile = get_or_create_user_profile(user_uid, email=user_email)
    tier = user_profile.get("subscription_tier", "standart")

    memory_block = build_memory_block(user_profile)
    system_content = f"{SYSTEM_PROMPT_GENERAL}\n\n{memory_block}" if memory_block else SYSTEM_PROMPT_GENERAL

    if req.attached_document and req.attached_document.excerpt:
        attached = req.attached_document
        system_content = (
            f"{system_content}\n\n"
            f"📎 EKLİ BELGE ({attached.filename}):\n{attached.excerpt}\n"
            "Kullanıcının sorularını bu belgedeki bilgilere dayanarak yanıtla."
        )

    messages = [{"role": "system", "content": system_content}]
    messages.extend(load_recent_history(user_uid))
    messages.append({"role": "user", "content": user_input})

    # Kaskad destekli canlı akış kurulumu (CEVAP: hata koduna göre sağlayıcı değişimi)
    try:
        generator, used_label = stream_chat_completion(
            messages,
            subscription_tier=tier,
            custom_gemini_key=req.custom_gemini_key,
            custom_groq_key=req.custom_groq_key,
            custom_github_token=req.custom_github_token
        )
    except ContentSafetyProviderError as exc:
        raise HTTPException(status_code=422, detail=f"İstek sağlayıcı güvenlik filtresine takıldı: {exc}")
    except ProviderConfigurationError as exc:
        raise raise_provider_http_error(exc)
    except ProviderAuthError as exc:
        raise raise_provider_http_error(exc)
    except ProviderUnavailableError as exc:
        raise raise_provider_http_error(exc)

    def stream_generator():
        full_reply = []
        try:
            for chunk in generator:
                full_reply.append(chunk)
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"

            joined = "".join(full_reply)
            smart_blocks = extract_smart_ui_blocks(joined)
            save_chat_turn(user_uid, user_input, joined)
            yield f"data: {json.dumps({'done': True, 'quota': format_quota_response(user_uid, has_custom_key), 'model_used': used_label, 'smart_ui': smart_blocks})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': f'Akış sırasında hata oluştu: {exc}'})}\n\n"

    return StreamingResponse(stream_generator(), media_type="text/event-stream")

# ============================================================
# GÖRSEL OLUŞTURMA ENDPOINT'İ
# Gemini Nano Banana (birincil) + Pollinations Flux (yedek)
# ============================================================

@app.post("/api/v1/generate-image")
def generate_image_endpoint(
    req: ImageGenRequest,
    user: dict = Depends(verify_token)
):
    user_uid = user.get("uid", "guest_user")
    raw_prompt = req.prompt.strip()
    has_custom_key = bool(req.custom_groq_key and req.custom_groq_key.strip())

    enforce_rate_limit(user_uid)

    if not raw_prompt:
        raise HTTPException(status_code=400, detail="Görsel açıklaması boş olamaz.")

    check_content_safety(raw_prompt)
    # Görsel kotası: günlük + sohbet başı (atomik)
    check_and_increment_quota(user_uid, "images", has_custom_key=has_custom_key, conversation_id=req.conversation_id)

    enhanced_prompt = enhance_image_prompt(raw_prompt, req.style)
    check_content_safety(enhanced_prompt)

    # ---- 1. Birincil: Gemini Nano Banana resim motoru (güncel) ----
    base_response = {
        "success": True,
        "original_prompt": raw_prompt,
        "enhanced_prompt": enhanced_prompt,
        "style": req.style,
        "aspect_ratio": req.aspect_ratio,
        "quota": format_quota_response(user_uid, has_custom_key)
    }
    if GEMINI_API_KEY:
        try:
            result = call_gemini_image(enhanced_prompt, aspect_ratio=req.aspect_ratio)
            saved_name = _save_base64_image(result.get("image_base64"), result.get("mime_type", "image/png"))
            if saved_name:
                return {
                    **base_response,
                    "image_url": f"/media/{saved_name}",
                    "is_local": True,
                    "engine": GEMINI_IMAGE_MODEL
                }
        except ProviderConfigurationError as exc:
            logger.warning(f"Gemini görsel motoru yapılandırılmamış, Pollinations'a geçiliyor: {exc}")
        except ProviderError as exc:
            logger.warning(f"Gemini görsel motoru başarısız, Pollinations'a geçiliyor: {exc}")

    # ---- 2. Yedek: Pollinations Flux Studio ----
    dim_map = {"1:1": (1024, 1024), "16:9": (1280, 720), "9:16": (720, 1280), "4:3": (1024, 768), "3:2": (1080, 720)}
    width, height = dim_map.get(req.aspect_ratio, (1024, 1024))
    seed = random.randint(10000, 999999)

    encoded_prompt = quote(enhanced_prompt, safe="")
    image_url = (
        f"https://image.pollinations.ai/prompt/{encoded_prompt}"
        f"?width={width}&height={height}&model=flux-realism&seed={seed}"
        f"&nologo=true&enhance=false&safe=true"
    )

    return {**base_response, "image_url": image_url, "is_local": False, "engine": "pollinations-flux"}

# ============================================================
# ARKA PLAN İŞLERİ (JOBS)
# ============================================================

JOB_TTL_SECONDS = 30 * 60
_JOB_EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="lumina-job")
_JOBS: Dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()

def _cleanup_jobs():
    now = time.time()
    with _JOBS_LOCK:
        for jid in [j for j, v in _JOBS.items() if now - v["created"] > JOB_TTL_SECONDS]:
            _JOBS.pop(jid, None)

def _run_job(job_id: str, fn, *args):
    try:
        result = fn(*args)
        outcome = {"status": "done", "result": result}
    except HTTPException as exc:
        outcome = {"status": "error", "error": {"status": exc.status_code, "detail": str(exc.detail)}}
    except Exception as exc:
        logger.exception("Arka plan işi hatası")
        outcome = {"status": "error", "error": {"status": 500, "detail": "Sunucu hatası oluştu."}}
    with _JOBS_LOCK:
        if job_id in _JOBS:
            _JOBS[job_id].update(outcome)
            _JOBS[job_id]["finished"] = time.time()

def _submit_job(uid: str, kind: str, fn, *args) -> str:
    _cleanup_jobs()
    job_id = uuid.uuid4().hex
    with _JOBS_LOCK:
        _JOBS[job_id] = {"uid": uid, "kind": kind, "status": "pending", "created": time.time()}
    _JOB_EXECUTOR.submit(_run_job, job_id, fn, *args)
    return job_id

@app.post("/api/v1/jobs/chat")
async def start_chat_job(req: ChatRequest, user: dict = Depends(verify_token)):
    job_id = _submit_job(user.get("uid", "guest_user"), "chat", chat_endpoint, req, user)
    return {"success": True, "job_id": job_id}

@app.post("/api/v1/jobs/image")
async def start_image_job(req: ImageGenRequest, user: dict = Depends(verify_token)):
    job_id = _submit_job(user.get("uid", "guest_user"), "image", generate_image_endpoint, req, user)
    return {"success": True, "job_id": job_id}

@app.get("/api/v1/jobs/{job_id}")
async def get_job(job_id: str, user: dict = Depends(verify_token)):
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        job = dict(job) if job else None
    if not job or job["uid"] != user.get("uid", "guest_user"):
        raise HTTPException(status_code=404, detail="İş bulunamadı veya süresi doldu.")
    return {
        "job_id": job_id,
        "kind": job["kind"],
        "status": job["status"],
        "result": job.get("result"),
        "error": job.get("error")
    }

# ============================================================
# KENDİLİĞİNDEN YAZMA (PROAKTİF MESAJ)
# ============================================================

class ProactiveRequest(BaseModel):
    idle_minutes: int = Field(default=5, ge=1, le=1440)
    local_time: Optional[str] = None
    unanswered: int = Field(default=0, ge=0, le=10)
    custom_groq_key: Optional[str] = None

@app.post("/api/v1/proactive")
def proactive_endpoint(req: ProactiveRequest, user: dict = Depends(verify_token)):
    uid = user.get("uid", "guest_user")
    profile = get_or_create_user_profile(uid)
    system_content = (
        f"{SYSTEM_PROMPT_GENERAL}\n\n"
        f"Kullanıcı yaklaşık {req.idle_minutes} dakikadır sessiz. "
        "Ona sıcak, kısa (1-2 cümle) ve dostane bir yoklama mesajı yaz. Veya uygun değilse SADECE 'SKIP' yaz."
    )
    messages = [{"role": "system", "content": system_content}]
    messages.extend(load_recent_history(uid)[-6:])
    messages.append({"role": "user", "content": "(Sistem: kullanıcı sessiz)"})

    try:
        text, _ = execute_chat_completion(messages, subscription_tier=profile.get("subscription_tier", "standart"), temperature=0.7, max_tokens=150)
        text = text.strip()
        if not text or text.upper().startswith("SKIP"):
            return {"success": True, "reply": None, "reason": "skip"}
        save_chat_turn(uid, "(Sessiz Yoklama)", text)
        return {"success": True, "reply": text}
    except Exception:
        return {"success": True, "reply": None, "reason": "model_error"}

# ============================================================
# SUNUCU BAŞLATICI
# ============================================================

if __name__ == "__main__":
    import uvicorn
    logger.info("Lumina AI Engine başlatılıyor...")
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
