# ============================================================
# LUMINA AI - GROQ API KEY POOL & USER ASSIGNMENT
# ============================================================
# Sunucu tarafli, sir sizdirmayan anahtar havuzu.
#
# Tasarim kurallari:
#   - Anahtarlar SADECE ortam degiskenlerinden okunur
#     (GROQ_KEY_01..GROQ_KEY_20 veya GROQ_API_KEY_1..20).
#   - Anahtar degerleri hicbir zaman log'a, API yanitina veya
#     istemciye gonderilmez. Istemciye yalnizca maskeli kimlik doner.
#   - Her anahtar en fazla MAX_USERS_PER_KEY kullaniciya atanir.
#   - Atama kaydi kullanici profilinde (api_key_assignment) tutulur;
#     Firestore varsa islem transaction ile yapilir.
#   - Ayni kullaniciya her girisde yeni anahtar atanmaz.
#   - Anahtar gecersizlesirse kullanici guvenli sekilde yeniden atanir;
#     sohbet gecmisi ve hesap verisi korunur.
# ============================================================

from __future__ import annotations

import os
import re
import time
import hmac
import hashlib
import logging
import secrets
import threading
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger("LuminaApiAllocation")

MAX_KEYS = 20
MAX_USERS_PER_KEY = 5

# Ayni IP'den gunluk yeni atama siniri (coklu hesap acip havuzu
# tuketmeyi zorlastirir). Ortam degiskeniyle ayarlanabilir.
DEFAULT_MAX_NEW_ASSIGNMENTS_PER_IP_PER_DAY = 3

_ASSIGNMENT_FIELD = "api_key_assignment"
_USAGE_COLLECTION = "api_key_usage"
_ASSIGNMENT_COLLECTION = "api_assignments"

_KEY_POOL: Dict[str, str] = {}
_KEY_ORDER: List[str] = []

_HEALTH_LOCK = threading.RLock()
_KEY_HEALTH: Dict[str, Dict[str, Any]] = {}

# Yerel, tek surec icinde atomik atama icin kullanilan depo.
# main.py baslangicta set_store() ile gercek LuminaStore'u enjekte eder.
_store = None


# ------------------------------------------------------------
# Anahtar havuzu
# ------------------------------------------------------------

def _normalize_key_id(index: int) -> str:
    return f"groq-{index:02d}"


def _read_env_key(index: int) -> str:
    """Numarali ortam degiskenlerini birden fazla adlandirma ile destekler."""
    candidates = (
        f"GROQ_KEY_{index:02d}",
        f"GROQ_KEY_{index}",
        f"GROQ_API_KEY_{index:02d}",
        f"GROQ_API_KEY_{index}",
    )
    for name in candidates:
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def reload_key_pool() -> int:
    """Ortam degiskenlerinden havuzu (yeniden) yukler. Yapilandirilan anahtar sayisini doner."""
    global _KEY_POOL, _KEY_ORDER
    pool: Dict[str, str] = {}
    order: List[str] = []
    for i in range(1, MAX_KEYS + 1):
        key = _read_env_key(i)
        if not key:
            continue
        # Gecersiz/sahte gorunumlu degerleri havuzda tutma.
        if len(key) < 20 or not re.fullmatch(r"[A-Za-z0-9_\-]+", key):
            logger.warning("GROQ_KEY_%02d gecersiz gorunumde; havuzdan cikarildi.", i)
            continue
        key_id = _normalize_key_id(i)
        pool[key_id] = key
        order.append(key_id)
    with _HEALTH_LOCK:
        _KEY_POOL = pool
        _KEY_ORDER = order
        for key_id in list(_KEY_HEALTH.keys()):
            if key_id not in pool:
                _KEY_HEALTH.pop(key_id, None)
    if pool:
        logger.info("Groq anahtar havuzu hazir: %d anahtar, kapasite %d kullanici.",
                    len(pool), len(pool) * MAX_USERS_PER_KEY)
    else:
        logger.warning("Groq anahtar havuzu bos. GROQ_KEY_01..20 tanimlanmadi.")
    return len(pool)


def get_legacy_key() -> str:
    """Eski tek anahtar (GROQ_API_KEY) - havuz yoksa son care."""
    return (os.getenv("GROQ_API_KEY") or "").strip()


def configured_key_count() -> int:
    return len(_KEY_POOL)


def mask_secret(secret: str) -> str:
    """Anahtari istemciye gostermeden maskeler."""
    if not secret:
        return ""
    if len(secret) <= 8:
        return "*" * len(secret)
    return f"{secret[:4]}...{secret[-4:]}"


def key_id_for_secret(secret: str) -> Optional[str]:
    for key_id, value in _KEY_POOL.items():
        if hmac.compare_digest(value, secret):
            return key_id
    return None


def _secret_for_id(key_id: Optional[str]) -> Optional[str]:
    if not key_id:
        return None
    return _KEY_POOL.get(key_id)


# ------------------------------------------------------------
# Depo enjeksiyonu
# ------------------------------------------------------------

def set_store(store_obj) -> None:
    """main.py tarafindan LuminaStore ornegi enjekte edilir."""
    global _store
    _store = store_obj


def _get_store():
    return _store


# ------------------------------------------------------------
# Atama kaydi (profil uzerinden, yerel atomik)
# ------------------------------------------------------------

def _active_assignment(profile: dict) -> Optional[dict]:
    assignment = profile.get(_ASSIGNMENT_FIELD)
    if not isinstance(assignment, dict):
        return None
    if assignment.get("status") not in (None, "active"):
        return None
    if not assignment.get("key_id"):
        return None
    return assignment


def _count_assignments(profiles: Iterable[dict]) -> Dict[str, int]:
    counts = {key_id: 0 for key_id in _KEY_ORDER}
    for profile in profiles:
        assignment = _active_assignment(profile) if isinstance(profile, dict) else None
        if assignment and assignment.get("key_id") in counts:
            counts[assignment["key_id"]] += 1
    return counts


def _choose_weighted(eligible: List[str], counts: Dict[str, int]) -> str:
    """Kalan kapasiteye gore kriptografik olarak guvenli agirlikli secim."""
    weights = [max(1, MAX_USERS_PER_KEY - counts.get(key_id, 0)) for key_id in eligible]
    total = sum(weights)
    pick = secrets.randbelow(total)
    upto = 0
    for key_id, weight in zip(eligible, weights):
        upto += weight
        if pick < upto:
            return key_id
    return eligible[-1]


def _local_allocate(uid: str, ip_key: Optional[str]) -> Optional[dict]:
    store = _get_store()
    if store is None:
        logger.warning("Atama deposu enjekte edilmedi; anahtar atanamadi.")
        return None

    result: Dict[str, Any] = {}

    def _mutate(profile: dict):
        existing = _active_assignment(profile)
        if existing:
            result["assignment"] = existing
            return

        profiles = [p for _, p in store.iter_profiles()]
        counts = _count_assignments(profiles)

        eligible = [k for k in _KEY_ORDER if counts.get(k, 0) < MAX_USERS_PER_KEY and _key_usable(k)]
        if not eligible:
            result["error"] = "pool_exhausted"
            raise RuntimeError("Tum API anahtarlari dolu.")

        chosen = _choose_weighted(eligible, counts)
        assignment = {
            "key_id": chosen,
            "status": "active",
            "assigned_at": int(time.time()),
            "source": "pool",
        }
        profile[_ASSIGNMENT_FIELD] = assignment
        result["assignment"] = assignment

    try:
        store.update_profile(uid, _mutate, default_factory=lambda: {"uid": uid})
    except RuntimeError:
        return None
    except Exception as exc:
        logger.error("Yerel anahtar atamasi basarisiz: %s", exc)
        return None
    return result.get("assignment")


def _firestore_allocate(uid: str, ip_key: Optional[str]) -> Optional[dict]:
    """Firestore varsa atomik atama. Hata durumunda yerel yola dusulur."""
    store = _get_store()
    db = getattr(store, "firestore_client", None) if store is not None else None
    if db is None:
        return None
    if not _KEY_ORDER:
        return None

    from google.cloud import firestore as fs

    assignment_ref = db.collection(_ASSIGNMENT_COLLECTION).document(uid)
    usage_ref = db.collection(_USAGE_COLLECTION).document("counts")

    @fs.transactional
    def _txn(transaction):
        snap = assignment_ref.get(transaction=transaction)
        if snap.exists:
            data = snap.to_dict() or {}
            if data.get("status") in (None, "active") and data.get("key_id") in _KEY_POOL:
                return data

        usage_snap = usage_ref.get(transaction=transaction)
        usage = (usage_snap.to_dict() or {}) if usage_snap.exists else {}
        counts = {key_id: int(usage.get(key_id, 0)) for key_id in _KEY_ORDER}

        eligible = [k for k in _KEY_ORDER if counts.get(k, 0) < MAX_USERS_PER_KEY and _key_usable(k)]
        if not eligible:
            raise RuntimeError("pool_exhausted")

        chosen = _choose_weighted(eligible, counts)
        assignment = {
            "key_id": chosen,
            "status": "active",
            "assigned_at": fs.SERVER_TIMESTAMP,
            "source": "pool",
        }
        transaction.set(assignment_ref, assignment)
        counts[chosen] = counts.get(chosen, 0) + 1
        transaction.set(usage_ref, counts, merge=True)
        return assignment

    try:
        return _txn(db.transaction())
    except RuntimeError:
        return None
    except Exception as exc:
        logger.warning("Firestore atamasi basarisiz, yerel yola dusuluyor: %s", exc)
        return None


def ensure_assignment(uid: str, ip_key: Optional[str] = None) -> Optional[dict]:
    """Kullaniciya atanmis aktif anahtar kaydini dondurur; yoksa guvenli sekilde atar."""
    if not uid:
        return None
    existing = get_assignment(uid)
    if existing:
        return existing

    # Yeni atama yapilacaksa IP gunluk kotasi tuketilir (hesap acip havuzu
    # tuketmeye calisan kullanicilari yavaslatir). Mevcut atamalar etkilenmez.
    if not _consume_ip_quota(ip_key):
        return None

    assignment = _firestore_allocate(uid, ip_key) or _local_allocate(uid, ip_key)
    if assignment:
        # Firestore yolu kullanildiysa profili de aynala (UI ve yedeklilik icin).
        store = _get_store()
        if store is not None:
            try:
                store.update_profile(
                    uid,
                    lambda p: p.__setitem__(_ASSIGNMENT_FIELD, {
                        "key_id": assignment.get("key_id"),
                        "status": "active",
                        "assigned_at": int(time.time()),
                        "source": assignment.get("source", "pool"),
                    }),
                    default_factory=lambda: {"uid": uid},
                )
            except Exception:
                pass
    return assignment


def get_assignment(uid: str) -> Optional[dict]:
    store = _get_store()
    if store is None or not uid:
        return None
    try:
        profile = store.get_profile(uid, create=False)
    except Exception:
        return None
    assignment = _active_assignment(profile) if isinstance(profile, dict) else None
    if not assignment:
        return None
    key_id = assignment.get("key_id")
    if key_id not in _KEY_POOL or not _key_usable(key_id):
        return None
    return assignment


def allocate_api_key_for_user(uid: str, ip_key: Optional[str] = None) -> Optional[str]:
    """Geriye uyumluluk: kullaniciya atanmis anahtarin kendisini doner.

    Bu fonksiyon SADECE sunucu ici kullanim icindir; sonucu asla HTTP
    yanitina koymayin.
    """
    assignment = ensure_assignment(uid, ip_key=ip_key)
    if not assignment:
        return None
    return _secret_for_id(assignment.get("key_id"))


def get_user_api_key(uid: str) -> Optional[str]:
    """Kullanicinin atanmis anahtarini sunucu ici dondurur (istemciye gonderilmez)."""
    assignment = get_assignment(uid)
    if not assignment:
        return None
    return _secret_for_id(assignment.get("key_id"))


def public_assignment(uid: str) -> Dict[str, Any]:
    """Istemciye guvenle gonderilebilecek atama ozeti (sir icermez)."""
    assignment = get_assignment(uid)
    if not assignment:
        return {"assigned": False}
    key_id = assignment.get("key_id")
    secret = _secret_for_id(key_id) or ""
    return {
        "assigned": True,
        "key_id": key_id,
        "masked_key": mask_secret(secret),
        "assigned_at": assignment.get("assigned_at"),
        "status": assignment.get("status", "active"),
    }


def resolve_chat_key(uid: str, custom_key: Optional[str]) -> Tuple[Optional[str], str]:
    """Sohbet icin kullanilacak Groq anahtarini ve kaynagini secer.

    Oncelik: kullanicinin kendi anahtari > havuz atamasi > eski tek anahtar.
    Kaynak degeri ("user" | "pool" | "legacy" | "none") kota politikasinda
    kullanilir; yalnizca "user" kotayi atlar.
    """
    custom = (custom_key or "").strip()
    if custom:
        return custom, "user"
    assigned = get_user_api_key(uid)
    if assigned:
        return assigned, "pool"
    legacy = get_legacy_key()
    if legacy:
        return legacy, "legacy"
    return None, "none"


# ------------------------------------------------------------
# Saglik / devre kesici
# ------------------------------------------------------------

def _key_usable(key_id: str) -> bool:
    with _HEALTH_LOCK:
        health = _KEY_HEALTH.get(key_id) or {}
        if health.get("invalid"):
            return False
        return time.time() >= float(health.get("open_until", 0) or 0)


def key_id_for_user(uid: str) -> Optional[str]:
    assignment = get_assignment(uid)
    return assignment.get("key_id") if assignment else None


def record_key_success(key_id: Optional[str]) -> None:
    if not key_id:
        return
    with _HEALTH_LOCK:
        health = _KEY_HEALTH.setdefault(key_id, {})
        health["failures"] = 0
        health["open_until"] = 0
        health["last_error"] = None


def record_key_failure(key_id: Optional[str], status: Optional[int] = None, error: str = "") -> None:
    """Anahtar hatasini kaydeder. 401/403 kalici gecersiz sayilir."""
    if not key_id:
        return
    with _HEALTH_LOCK:
        health = _KEY_HEALTH.setdefault(key_id, {})
        if status in (401, 403):
            health["invalid"] = True
            health["last_error"] = f"auth:{status}"
            logger.warning("Anahtar %s yetkisiz (HTTP %s); havuzdan cikarildi.", key_id, status)
        else:
            health["failures"] = int(health.get("failures", 0)) + 1
            health["last_error"] = (error or "")[:120]
            if health["failures"] >= 3:
                health["open_until"] = time.time() + 60
                health["failures"] = 0


def reassign_user(uid: str, reason: str = "invalid_key") -> Optional[dict]:
    """Gecersiz anahtar atamasini kaldirip yeni anahtar atar. Sohbet gecmisi korunur."""
    store = _get_store()
    if store is None:
        return None

    def _mutate(profile: dict):
        old = profile.get(_ASSIGNMENT_FIELD) or {}
        profile["api_key_assignment_history"] = (
            list(profile.get("api_key_assignment_history") or []) + [{
                "key_id": old.get("key_id"),
                "reason": reason,
                "timestamp": int(time.time()),
            }]
        )[-20:]
        profile[_ASSIGNMENT_FIELD] = None

    try:
        store.update_profile(uid, _mutate, default_factory=lambda: {"uid": uid})
    except Exception as exc:
        logger.error("Anahtar atamasi sifirlanamadi: %s", exc)
        return None
    return ensure_assignment(uid)


def _max_new_assignments_per_ip() -> int:
    try:
        return max(1, int(os.getenv("LUMINA_MAX_NEW_ASSIGNMENTS_PER_IP_PER_DAY", "3")))
    except (TypeError, ValueError):
        return DEFAULT_MAX_NEW_ASSIGNMENTS_PER_IP_PER_DAY


# IP gunluk atama sayaci, kullanici profilinden BAGIMSIZ tutulur; aksi halde
# her yeni hesap kendi sayacini sifirdan baslatir ve sinir islevsiz kalir.
_IP_USAGE_UID = "__system_ip_usage__"
_IP_USAGE_LOCK = threading.RLock()


def _consume_ip_quota(ip_key: Optional[str]) -> bool:
    """IP icin gunluk yeni atama kotasini atomik tuketir. Sinir asilirsa False."""
    if not ip_key:
        return True
    store = _get_store()
    if store is None:
        return True

    limit = _max_new_assignments_per_ip()
    today = time.strftime("%Y-%m-%d")
    outcome = {"allowed": True}

    def _mutate(profile: dict):
        usage = profile.get("ip_usage")
        if not isinstance(usage, dict):
            usage = {}
        entry = usage.get(ip_key) or {"date": today, "count": 0}
        if entry.get("date") != today:
            entry = {"date": today, "count": 0}
        if int(entry.get("count", 0)) >= limit:
            outcome["allowed"] = False
            raise RuntimeError("ip_limit")
        entry["count"] = int(entry.get("count", 0)) + 1
        usage[ip_key] = entry
        # Sinirli sayida IP kaydi tut.
        if len(usage) > 500:
            usage = dict(list(usage.items())[-500:])
        profile["ip_usage"] = usage

    try:
        with _IP_USAGE_LOCK:
            store.update_profile(
                _IP_USAGE_UID,
                _mutate,
                default_factory=lambda: {"uid": _IP_USAGE_UID},
            )
    except RuntimeError:
        logger.warning("IP gunluk atama siniri asildi (%s).", ip_key)
        return False
    except Exception as exc:
        # Depo hatasi kullaniciyi kilitlememeli; yalnizca logla.
        logger.warning("IP atama kotasi okunamadi: %s", exc)
        return True
    return outcome["allowed"]


def pool_status() -> Dict[str, Any]:
    """Yonetici/UI icin sir icermeyen havuz durumu."""
    store = _get_store()
    counts: Dict[str, int] = {key_id: 0 for key_id in _KEY_ORDER}
    if store is not None:
        try:
            counts = _count_assignments(p for _, p in store.iter_profiles())
        except Exception:
            pass

    items = []
    with _HEALTH_LOCK:
        for key_id in _KEY_ORDER:
            secret = _KEY_POOL.get(key_id, "")
            health = dict(_KEY_HEALTH.get(key_id) or {})
            used = counts.get(key_id, 0)
            items.append({
                "key_id": key_id,
                "masked_key": mask_secret(secret),
                "assigned_users": used,
                "capacity": MAX_USERS_PER_KEY,
                "available_slots": max(0, MAX_USERS_PER_KEY - used),
                "usable": _key_usable(key_id),
                "invalid": bool(health.get("invalid")),
                "last_error": health.get("last_error"),
            })

    total_capacity = len(_KEY_ORDER) * MAX_USERS_PER_KEY
    total_used = sum(i["assigned_users"] for i in items)
    return {
        "configured_keys": len(_KEY_ORDER),
        "max_keys": MAX_KEYS,
        "max_users_per_key": MAX_USERS_PER_KEY,
        "total_capacity": total_capacity,
        "total_assigned": total_used,
        "available_slots": max(0, total_capacity - total_used),
        "legacy_key_present": bool(get_legacy_key()),
        "keys": items,
    }


# Modul yuklenirken havuzu hazirla (main.py load_dotenv sonrasi reload eder).
reload_key_pool()
