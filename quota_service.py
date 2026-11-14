# ============================================================
# LUMINA AI - KALICI / ATOMİK GÜNLÜK KOTA SERVİSİ
# ============================================================
# Tasarım:
#   - Yetkili kaynak (authoritative) üretimde Firestore'dur. Her kullanıcı
#     için `user_quota_usage/{uid}` dokümanı transaction ile güncellenir.
#   - Firestore yoksa (yalnızca geliştirme) yerel JSON deposu kullanılır;
#     `LuminaStore.update_profile` süreç içi RLock altında atomiktir.
#   - Günlük sıfırlama Europe/Istanbul (sabit UTC+3) tarihine göre yapılır.
#   - Mesaj ve görsel sayaçları AYRIDIR. Sohbet başına görsel sayacı aynı
#     kayıtta tutulur.
#   - Sağlayıcı (Groq/Google/konum) kotaları bu servisten AYRIDIR.
#   - İstemciden gelen sayaç/plan bilgisi asla kullanılmaz; uid sunucuda
#     doğrulanmış kimlikten gelir.
#   - Üretimde Firestore'a erişilemezse yerel moda SESSİZCE düşülmez;
#     QuotaStorageError fırlatılır.
#
# Ücretlendirme kuralları:
#   - Mesaj: istek kabulünde ücretlendirilir. Sağlayıcı hiç çıktı üretmeden
#     hata verirse `release()` ile geri bırakılır.
#   - Görsel: yalnızca doğrulanmış başarılı üretimden sonra commit edilir.
#     `commit=False` yalnızca limit doğrular.
# ============================================================

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional

from runtime_config import is_production
from subscriptions import get_effective_plan, get_today_str, TURKEY_TZ_OFFSET

logger = logging.getLogger("LuminaQuota")

QUOTA_COLLECTION = "user_quota_usage"
DAILY_RESET_TIMEZONE = "Europe/Istanbul (sabit UTC+3)"
MAX_CONVERSATION_ENTRIES = 50
MAX_CONVERSATION_ID_LENGTH = 128


class QuotaExceededError(Exception):
    """Kullanıcının plan kotası dolduğunda fırlatılır."""

    def __init__(
        self,
        kind: str,
        used: int,
        limit: int,
        plan_name: str,
        *,
        conversation_used: Optional[int] = None,
        conversation_limit: Optional[int] = None,
    ):
        self.kind = kind
        self.used = used
        self.limit = limit
        self.plan_name = plan_name
        self.conversation_used = conversation_used
        self.conversation_limit = conversation_limit
        super().__init__(self.message)

    @property
    def message(self) -> str:
        if self.kind == "messages":
            return (
                f"⚠️ Günlük mesaj kotanız dolmuştur ({self.used}/{self.limit}). "
                f"Mevcut paketiniz: {self.plan_name}. "
                "Daha yüksek kotalara ve gelişmiş yapay zeka modellerine geçmek için "
                "lütfen 💎 Paketler menüsünden aboneliğinizi yükseltin veya "
                "⚙️ Ayarlar menüsünden kendi API anahtarınızı tanımlayın."
            )
        if self.kind == "images" and self.conversation_limit is not None:
            return (
                f"⚠️ Bu sohbetteki görsel hakkınız dolmuştur "
                f"({self.conversation_used}/{self.conversation_limit}). "
                "Yeni bir sohbet başlatabilirsiniz veya paketinizi yükseltebilirsiniz."
            )
        return (
            f"⚠️ Günlük görsel üretim kotanız dolmuştur ({self.used}/{self.limit}). "
            f"Mevcut paketiniz: {self.plan_name}. "
            "Görsel stüdyosunu kesintisiz kullanmak için lütfen "
            "💎 Paketler menüsünden Pro / Lüks paketlerine göz atın."
        )


class QuotaStorageError(RuntimeError):
    """Kota deposuna ulaşılamadığında (üretimde sessiz yerel düşüş yok)."""


def quota_limits(plan: Dict[str, Any], kind: str) -> tuple:
    """(limit, unlimited) döner. Plan değerleri sunucu tarafındadır."""
    if kind == "messages":
        limit = int(plan.get("messages_per_day") or 250)
        unlimited = bool(plan.get("is_unlimited_text", False))
        return limit, unlimited
    if kind == "images":
        limit = int(plan.get("images_per_day") or 5)
        unlimited = bool(plan.get("is_unlimited_image", False))
        return limit, unlimited
    raise ValueError(f"Bilinmeyen kota türü: {kind}")


def _conversation_limit(plan: Dict[str, Any]) -> int:
    return int(plan.get("images_per_conversation") or 10)


def _normalize_conversation_id(conversation_id: Optional[str]) -> Optional[str]:
    if not conversation_id:
        return None
    value = str(conversation_id).strip()[:MAX_CONVERSATION_ID_LENGTH]
    return value or None


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


class QuotaManager:
    """Kullanıcı günlük kotasını kalıcı ve atomik yönetir."""

    def __init__(self, store_getter: Callable[[], Any]):
        # store_getter, testlerde `main.store` yeniden bağlandığında da
        # güncel depoyu görmesini sağlar (closure/global okuma).
        self._store_getter = store_getter

    # --------------------------------------------------------
    # Altyapı
    # --------------------------------------------------------

    @property
    def store(self):
        try:
            return self._store_getter()
        except Exception:
            return None

    def _firestore_db(self):
        store = self.store
        if store is None:
            return None
        if not getattr(store, "firebase_enabled", False):
            return None
        return getattr(store, "firestore_client", None)

    @property
    def backend(self) -> str:
        return "firestore" if self._firestore_db() is not None else "local"

    def describe(self) -> Dict[str, Any]:
        return {
            "backend": self.backend,
            "timezone": DAILY_RESET_TIMEZONE,
            "collection": QUOTA_COLLECTION if self.backend == "firestore" else None,
            "daily_reset_basis": "UTC+3 tarih değişimi",
        }

    # --------------------------------------------------------
    # Kayıt yardımcıları
    # --------------------------------------------------------

    @staticmethod
    def _blank_record(today: str) -> Dict[str, Any]:
        return {
            "date": today,
            "messages": 0,
            "images": 0,
            "conversations": {},
        }

    @classmethod
    def _normalize_record(cls, data: Any, today: str) -> Dict[str, Any]:
        if not isinstance(data, dict) or data.get("date") != today:
            return cls._blank_record(today)

        conversations: Dict[str, int] = {}
        raw_conversations = data.get("conversations")
        if isinstance(raw_conversations, dict):
            for cid, value in list(raw_conversations.items())[-MAX_CONVERSATION_ENTRIES:]:
                if not cid:
                    continue
                key = str(cid)[:MAX_CONVERSATION_ID_LENGTH]
                conversations[key] = _as_int(value)
        return {
            "date": today,
            "messages": _as_int(data.get("messages")),
            "images": _as_int(data.get("images")),
            "conversations": conversations,
        }

    @staticmethod
    def _profile_conversations(profile: Dict[str, Any], today: str) -> Dict[str, int]:
        raw = profile.get("conversation_image_usage")
        conversations: Dict[str, int] = {}
        if not isinstance(raw, dict):
            return conversations
        for cid, entry in list(raw.items())[-MAX_CONVERSATION_ENTRIES:]:
            if not isinstance(entry, dict) or entry.get("date") != today:
                continue
            key = str(cid)[:MAX_CONVERSATION_ID_LENGTH]
            conversations[key] = _as_int(entry.get("count"))
        return conversations

    @staticmethod
    def _write_profile_record(profile: Dict[str, Any], record: Dict[str, Any]) -> None:
        today = record["date"]
        usage = profile.get("daily_usage")
        if not isinstance(usage, dict):
            usage = {}
        usage["date"] = today
        usage["messages"] = _as_int(record.get("messages"))
        usage["images"] = _as_int(record.get("images"))
        profile["daily_usage"] = usage

        conversations = record.get("conversations") or {}
        profile["conversation_image_usage"] = {
            cid: {"date": today, "count": _as_int(count)}
            for cid, count in list(conversations.items())[-MAX_CONVERSATION_ENTRIES:]
        }

    def _record_from_profile(self, profile: Dict[str, Any], today: str) -> Dict[str, Any]:
        usage = profile.get("daily_usage")
        if not isinstance(usage, dict) or usage.get("date") != today:
            usage = {}
        return {
            "date": today,
            "messages": _as_int(usage.get("messages")),
            "images": _as_int(usage.get("images")),
            "conversations": self._profile_conversations(profile, today),
        }

    # --------------------------------------------------------
    # Doğrulama / tüketim mantığı (backend bağımsız)
    # --------------------------------------------------------

    @staticmethod
    def _apply_usage(
        record: Dict[str, Any],
        *,
        kind: str,
        plan: Dict[str, Any],
        conversation_id: Optional[str],
        commit: bool,
        increment: int,
    ) -> Dict[str, Any]:
        """Kayıt üzerinde limit doğrular ve (commit ise) sayacı arttırır.

        Record yerinde değiştirilir. Limit aşılırsa QuotaExceededError fırlatır;
        bu durumda çağıran transaction/yazma işlemini geri almalıdır.
        """
        limit, unlimited = quota_limits(plan, kind)
        plan_name = plan.get("name") or plan.get("id") or "Bilinmeyen Paket"

        if kind == "messages":
            used = _as_int(record.get("messages"))
            if not unlimited and used >= limit:
                raise QuotaExceededError("messages", used, limit, plan_name)
            if commit:
                record["messages"] = used + increment
            return record

        # Görsel: günlük kota
        used = _as_int(record.get("images"))
        if not unlimited and used >= limit:
            raise QuotaExceededError("images", used, limit, plan_name)

        # Sohbet başına görsel kotası
        if conversation_id:
            conversations = record.get("conversations")
            if not isinstance(conversations, dict):
                conversations = {}
                record["conversations"] = conversations
            conv_used = _as_int(conversations.get(conversation_id))
            conv_limit = _conversation_limit(plan)
            if conv_used >= conv_limit:
                raise QuotaExceededError(
                    "images",
                    used,
                    limit,
                    plan_name,
                    conversation_used=conv_used,
                    conversation_limit=conv_limit,
                )
            if commit:
                conversations[conversation_id] = conv_used + increment
                # Sınırlı sayıda sohbet kaydı tutulur.
                if len(conversations) > MAX_CONVERSATION_ENTRIES:
                    for key in list(conversations.keys())[:-MAX_CONVERSATION_ENTRIES]:
                        conversations.pop(key, None)

        if commit:
            record["images"] = used + increment
        return record

    # --------------------------------------------------------
    # Yerel (geliştirme) yol
    # --------------------------------------------------------

    def _local_consume(
        self,
        uid: str,
        kind: str,
        plan: Dict[str, Any],
        *,
        conversation_id: Optional[str],
        commit: bool,
        increment: int,
        default_factory: Optional[Callable[[], dict]],
    ) -> Dict[str, Any]:
        store = self.store
        if store is None:
            raise QuotaStorageError("Yerel kota deposu hazır değil.")
        today = get_today_str()
        outcome: Dict[str, Any] = {}

        def _mutate(profile: Dict[str, Any]) -> None:
            record = self._record_from_profile(profile, today)
            self._apply_usage(
                record,
                kind=kind,
                plan=plan,
                conversation_id=conversation_id,
                commit=commit,
                increment=increment,
            )
            if commit:
                self._write_profile_record(profile, record)
            outcome.update(record)

        try:
            store.update_profile(uid, _mutate, default_factory=default_factory)
        except QuotaExceededError:
            raise
        except Exception as exc:
            raise QuotaStorageError(f"Yerel kota kaydı güncellenemedi: {exc}") from exc
        return outcome

    # --------------------------------------------------------
    # Firestore (üretim) yolu
    # --------------------------------------------------------

    def _firestore_consume(
        self,
        uid: str,
        kind: str,
        plan: Dict[str, Any],
        *,
        conversation_id: Optional[str],
        commit: bool,
        increment: int,
        default_factory: Optional[Callable[[], dict]],
    ) -> Dict[str, Any]:
        db = self._firestore_db()
        if db is None:
            raise QuotaStorageError("Firestore istemcisi hazır değil.")
        try:
            from google.cloud import firestore as fs
        except Exception as exc:  # pragma: no cover - kurulum hatası
            raise QuotaStorageError("Firestore transaction API'si yüklenemedi.") from exc

        today = get_today_str()
        doc_ref = db.collection(QUOTA_COLLECTION).document(uid)

        @fs.transactional
        def _txn(transaction):
            snap = doc_ref.get(transaction=transaction)
            record = self._normalize_record(
                snap.to_dict() if snap.exists else None, today
            )
            self._apply_usage(
                record,
                kind=kind,
                plan=plan,
                conversation_id=conversation_id,
                commit=commit,
                increment=increment,
            )
            if commit:
                transaction.set(doc_ref, record)
            return record

        try:
            record = _txn(db.transaction())
        except QuotaExceededError:
            raise
        except Exception as exc:
            if is_production():
                raise QuotaStorageError(
                    f"Firestore kota transaction'ı başarısız: {exc}"
                ) from exc
            # Geliştirmede Firestore geçici olarak kullanılamıyorsa yerel yola geç.
            logger.warning("Firestore kota yolu başarısız; yerel yola düşülüyor: %s", exc)
            return self._local_consume(
                uid,
                kind,
                plan,
                conversation_id=conversation_id,
                commit=commit,
                increment=increment,
                default_factory=default_factory,
            )

        if commit:
            self._mirror_record_to_profile(uid, record, default_factory)
        return record

    def _mirror_record_to_profile(
        self,
        uid: str,
        record: Dict[str, Any],
        default_factory: Optional[Callable[[], dict]],
    ) -> None:
        """Yetkili Firestore kaydını profile (UI/yerel yedek) yansıtır.

        Yansıtma başarısız olsa bile yetkili kota kaydı bozulmaz.
        """
        store = self.store
        if store is None:
            return

        def _mutate(profile: Dict[str, Any]) -> None:
            self._write_profile_record(profile, record)

        try:
            store.update_profile(uid, _mutate, default_factory=default_factory)
        except Exception as exc:
            logger.debug("Kota profili yansıtılamadı (%s): %s", uid, exc)

    def _firestore_snapshot(self, uid: str) -> Optional[Dict[str, Any]]:
        db = self._firestore_db()
        if db is None:
            return None
        try:
            snap = db.collection(QUOTA_COLLECTION).document(uid).get()
        except Exception as exc:
            if is_production():
                raise QuotaStorageError(f"Firestore kota kaydı okunamadı: {exc}") from exc
            logger.warning("Firestore kota kaydı okunamadı; yerel yola düşülüyor: %s", exc)
            return None
        return self._normalize_record(snap.to_dict() if snap.exists else None, get_today_str())

    # --------------------------------------------------------
    # Genel API
    # --------------------------------------------------------

    def resolve_plan(
        self,
        uid: str,
        *,
        default_factory: Optional[Callable[[], dict]] = None,
    ) -> Dict[str, Any]:
        store = self.store
        if store is None:
            raise QuotaStorageError("Kota deposu hazır değil.")
        profile = store.get_profile(uid, default_factory=default_factory)
        return get_effective_plan(profile)

    def consume(
        self,
        uid: str,
        kind: str,
        *,
        plan: Optional[Dict[str, Any]] = None,
        default_factory: Optional[Callable[[], dict]] = None,
        conversation_id: Optional[str] = None,
        commit: bool = True,
        increment: int = 1,
    ) -> Dict[str, Any]:
        """Kotayı doğrular ve (commit ise) atomik olarak tüketir."""
        if kind not in ("messages", "images"):
            raise ValueError(f"Bilinmeyen kota türü: {kind}")
        if increment < 1:
            raise ValueError("increment en az 1 olmalıdır.")
        conv_id = _normalize_conversation_id(conversation_id) if kind == "images" else None
        if plan is None:
            plan = self.resolve_plan(uid, default_factory=default_factory)

        if self.backend == "firestore":
            return self._firestore_consume(
                uid,
                kind,
                plan,
                conversation_id=conv_id,
                commit=commit,
                increment=increment,
                default_factory=default_factory,
            )
        return self._local_consume(
            uid,
            kind,
            plan,
            conversation_id=conv_id,
            commit=commit,
            increment=increment,
            default_factory=default_factory,
        )

    def validate(
        self,
        uid: str,
        kind: str,
        *,
        plan: Optional[Dict[str, Any]] = None,
        default_factory: Optional[Callable[[], dict]] = None,
        conversation_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Yalnızca limitleri doğrular; sayaçları arttırmaz."""
        return self.consume(
            uid,
            kind,
            plan=plan,
            default_factory=default_factory,
            conversation_id=conversation_id,
            commit=False,
        )

    def snapshot(
        self,
        uid: str,
        *,
        plan: Optional[Dict[str, Any]] = None,
        default_factory: Optional[Callable[[], dict]] = None,
    ) -> Dict[str, Any]:
        """Güncel kullanımı döner (gün değiştiyse sıfır)."""
        if plan is None:
            plan = self.resolve_plan(uid, default_factory=default_factory)

        if self.backend == "firestore":
            record = self._firestore_snapshot(uid)
            if record is not None:
                return {
                    "messages": record["messages"],
                    "images": record["images"],
                    "conversations": dict(record["conversations"]),
                    "date": record["date"],
                    "backend": "firestore",
                }

        store = self.store
        if store is None:
            raise QuotaStorageError("Kota deposu hazır değil.")
        today = get_today_str()
        try:
            profile = store.get_profile(uid, default_factory=default_factory)
        except Exception as exc:
            raise QuotaStorageError(f"Yerel kota kaydı okunamadı: {exc}") from exc
        record = self._record_from_profile(profile, today)
        return {
            "messages": record["messages"],
            "images": record["images"],
            "conversations": dict(record["conversations"]),
            "date": today,
            "backend": "local",
        }

    def release(
        self,
        uid: str,
        kind: str,
        *,
        conversation_id: Optional[str] = None,
        default_factory: Optional[Callable[[], dict]] = None,
    ) -> bool:
        """Başarısız istek için tüketilen kotayı geri bırakır (en fazla 1).

        Geri bırakma telafi amaçlıdır; depo hatasında kullanıcıya yeni bir
        hata gösterilmez (asıl hata maskelenmemelidir). Başarılıysa True.
        """
        if kind not in ("messages", "images"):
            return False
        conv_id = _normalize_conversation_id(conversation_id) if kind == "images" else None
        if self.backend == "firestore":
            try:
                return self._firestore_release(uid, kind, conv_id)
            except Exception as exc:
                logger.warning("Kota geri bırakma başarısız (%s): %s", uid, exc)
                return False
        return self._local_release(uid, kind, conv_id, default_factory)

    def _local_release(
        self,
        uid: str,
        kind: str,
        conversation_id: Optional[str],
        default_factory: Optional[Callable[[], dict]],
    ) -> bool:
        store = self.store
        if store is None:
            return False
        today = get_today_str()
        outcome = {"released": False}

        def _mutate(profile: Dict[str, Any]) -> None:
            record = self._record_from_profile(profile, today)
            if kind == "messages":
                if record["messages"] > 0:
                    record["messages"] -= 1
                    outcome["released"] = True
            else:
                if record["images"] > 0:
                    record["images"] -= 1
                    outcome["released"] = True
                if conversation_id:
                    conversations = record.get("conversations") or {}
                    used = _as_int(conversations.get(conversation_id))
                    if used > 0:
                        conversations[conversation_id] = used - 1
                        outcome["released"] = True
            if outcome["released"]:
                self._write_profile_record(profile, record)

        try:
            store.update_profile(uid, _mutate, default_factory=default_factory)
        except Exception as exc:
            logger.warning("Yerel kota geri bırakılamadı (%s): %s", uid, exc)
            return False
        return outcome["released"]

    def _firestore_release(
        self,
        uid: str,
        kind: str,
        conversation_id: Optional[str],
    ) -> bool:
        db = self._firestore_db()
        if db is None:
            return False
        from google.cloud import firestore as fs

        today = get_today_str()
        doc_ref = db.collection(QUOTA_COLLECTION).document(uid)

        @fs.transactional
        def _txn(transaction):
            snap = doc_ref.get(transaction=transaction)
            if not snap.exists:
                return False
            record = self._normalize_record(snap.to_dict(), today)
            # Kayıt bugüne ait değilse geri bırakılacak tüketim yoktur.
            if (snap.to_dict() or {}).get("date") != today:
                return False
            changed = False
            if kind == "messages" and record["messages"] > 0:
                record["messages"] -= 1
                changed = True
            elif kind == "images":
                if record["images"] > 0:
                    record["images"] -= 1
                    changed = True
                if conversation_id:
                    conversations = record.get("conversations") or {}
                    used = _as_int(conversations.get(conversation_id))
                    if used > 0:
                        conversations[conversation_id] = used - 1
                        changed = True
            if changed:
                transaction.set(doc_ref, record)
            return changed

        return bool(_txn(db.transaction()))
