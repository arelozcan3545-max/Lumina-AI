# ============================================================
# LUMINA AI - VERİ DEPOSU SOYUTLAMASI (v3.1)
# Atomik Yerel JSON Deposu + Opsiyonel Firestore Ayna (Mirror)
#
# NOT (16 Ekim 2026):
#   Önceden kullanıcı/profil/hafıza işlemleri main.py içine dağınık,
#   kilitsiz ve yarış koşullarına açık bir şekilde yazılıyordu.
#   Bu katman; tek kilit (_STORE_LOCK) altında ATOMİK okuma/yazma,
#   dosya bozulmasına dayanıklı yazım (tmp + os.replace) ve
#   "serviceAccountKey.json" varsa Firestore aynasını birleştirir.
#   Firebase yoksa sıfır bağımlılık ile yerel modda çalışır.
# ============================================================

import os
import json
import time
import threading
import logging
from typing import Optional, Callable, Iterator, Dict, Any, List

logger = logging.getLogger("LuminaStorage")

# Opsiyonel Firebase Admin SDK (kurulu değilse yerel mod devrede)
try:
    import firebase_admin
    from firebase_admin import credentials, firestore as _firestore
    HAS_FIREBASE_MODULE = True
except ImportError:
    HAS_FIREBASE_MODULE = False

# ------------------------------------------------------------
# Sabitler
# ------------------------------------------------------------
MAX_HISTORY_TURNS = 120          # Kullanıcı başına saklanan sohbet turu üst sınırı
MAX_FIRESTORE_SYNC_DOCS = 500    # Başlangıçta indirilecek azami profil sayısı


class LuminaStore:
    """Lumina AI'ın tek kilitli, atomik ve Firestore destekli veri deposu.

    Depo şeması (yerel JSON):
    {
      "profiles": { "<uid>": {profil sözlüğü} },
      "<uid>":    [ {"user": ..., "bot": ..., "timestamp": ...}, ... ]
    }
    """

    def __init__(
        self,
        memory_file: str,
        firebase_enabled: bool = False,
        firestore_client: Optional[Any] = None
    ):
        self._lock = threading.RLock()
        self._memory_file = memory_file
        self._firebase_enabled = bool(firebase_enabled)
        self._db = firestore_client  # google.cloud.firestore client veya None

        if self._firebase_enabled and self._db is None and HAS_FIREBASE_MODULE:
            try:
                self._db = _firestore.client()
            except Exception as exc:
                logger.warning(f"Firestore istemcisi oluşturulamadı (yerel modda devam): {exc}")
                self._firebase_enabled = False

    # --------------------------------------------------------
    # Yerel atomik okuma/yazma
    # --------------------------------------------------------

    def load_all(self) -> dict:
        """Tüm yerel depoyu güvenle yükler (kilitli, bozuk dosyaya tolerant)."""
        with self._lock:
            if os.path.exists(self._memory_file):
                for attempt in range(2):
                    try:
                        with open(self._memory_file, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        if isinstance(data, dict):
                            return data
                        return {}
                    except Exception as exc:
                        # Yedek .tmp dosyası varsa kurtar
                        tmp_path = f"{self._memory_file}.tmp"
                        if attempt == 0 and os.path.exists(tmp_path):
                            try:
                                with open(tmp_path, "r", encoding="utf-8") as f:
                                    data = json.load(f)
                                if isinstance(data, dict):
                                    return data
                            except Exception:
                                pass
                        logger.warning(f"Yerel depo okunamadı ({self._memory_file}): {exc}")
            return {}

    def save_all(self, data: dict) -> None:
        """Depoyu atomik olarak yazar (tmp dosyasına yaz → os.replace)."""
        with self._lock:
            tmp_path = f"{self._memory_file}.tmp"
            try:
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                os.replace(tmp_path, self._memory_file)
            except Exception as exc:
                logger.warning(f"Yerel depo kaydedilemedi: {exc}")

    # --------------------------------------------------------
    # Firestore aynası (opsiyonel)
    # --------------------------------------------------------

    @property
    def firebase_enabled(self) -> bool:
        return self._firebase_enabled

    @property
    def firestore_client(self):
        return self._db

    def _mirror_profile(self, uid: str, profile: dict) -> None:
        """Profili Firestore'a yazar (hata toleranslı, kilitleme yapmaz)."""
        if not (self._firebase_enabled and self._db):
            return
        try:
            self._db.collection("profiles").document(uid).set(profile, merge=True)
        except Exception as exc:
            logger.warning(f"Firestore profil aynası yazılamadı ({uid}): {exc}")

    def _fetch_firebase_profile(self, uid: str) -> Optional[dict]:
        if not (self._firebase_enabled and self._db):
            return None
        try:
            snap = self._db.collection("profiles").document(uid).get()
            if snap.exists and snap.to_dict():
                return snap.to_dict()
        except Exception as exc:
            logger.debug(f"Firestore profil okuması atlandı ({uid}): {exc}")
        return None

    def sync_profiles_from_firestore(self) -> int:
        """Başlangıçta Firestore profillerini yerel depoya çeker (limitli)."""
        if not (self._firebase_enabled and self._db):
            return 0
        downloaded = 0
        try:
            docs = self._db.collection("profiles").limit(MAX_FIRESTORE_SYNC_DOCS).stream()
            with self._lock:
                store = self.load_all()
                profiles = store.setdefault("profiles", {})
                for doc in docs:
                    data = doc.to_dict()
                    if data:
                        profiles[doc.id] = data
                        downloaded += 1
                self.save_all(store)
        except Exception as exc:
            logger.warning(f"Firestore senkronizasyonu atlandı: {exc}")
        return downloaded

    # --------------------------------------------------------
    # Profil işlemleri (ATOMİK)
    # --------------------------------------------------------

    def get_profile(
        self,
        uid: str,
        default_factory: Optional[Callable[[], dict]] = None,
        create: bool = True
    ) -> dict:
        """Kullanıcı profilini döner; yoksa oluşturur (Firestore > yerel önceliği)."""
        with self._lock:
            store = self.load_all()
            profiles = store.setdefault("profiles", {})

            profile = profiles.get(uid)
            if profile is None:
                profile = self._fetch_firebase_profile(uid)

            if profile is None:
                if not create:
                    return {}
                profile = default_factory() if default_factory else {"uid": uid}
                profiles[uid] = profile
                self.save_all(store)
                self._mirror_profile(uid, profile)
                return profile

            return profile

    def update_profile(
        self,
        uid: str,
        mutate: Callable[[dict], Any],
        default_factory: Optional[Callable[[], dict]] = None
    ) -> dict:
        """Profili TEK KİLİT altında okuyup mutasyon uygulayıp geri yazar (yarış koşulu koruması).

        `mutate(profile)` fonksiyonu profili yerinde değiştirebilir veya exception fırlatabilir.
        Exception durumunda değişiklik diske YAZILMAZ.
        """
        with self._lock:
            store = self.load_all()
            profiles = store.setdefault("profiles", {})
            profile = profiles.get(uid) or self._fetch_firebase_profile(uid) or (
                default_factory() if default_factory else {"uid": uid}
            )
            mutate(profile)  # exception durumunda aşağıdaki yazım adımları atlanır
            profiles[uid] = profile
            self.save_all(store)
            self._mirror_profile(uid, profile)
            return profile

    def set_profile(self, uid: str, profile: dict) -> dict:
        """Profili tamamen değiştirir (atomik)."""
        with self._lock:
            store = self.load_all()
            store.setdefault("profiles", {})[uid] = profile
            self.save_all(store)
            self._mirror_profile(uid, profile)
            return profile

    def iter_profiles(self) -> Iterator[tuple]:
        """Tüm profilleri (uid, profile) çiftleri olarak gezderir."""
        with self._lock:
            store = self.load_all()
            for uid, profile in list(store.get("profiles", {}).items()):
                yield uid, profile

    def find_profiles_matching_email(self, email_lower: str) -> List[tuple]:
        """Verilen e-posta ile eşleşen aile üyesi içeren (uid, profil) çiftlerini döner."""
        matches = []
        for uid, profile in self.iter_profiles():
            for member in profile.get("family_members", []):
                if isinstance(member, dict) and member.get("email") == email_lower:
                    matches.append((uid, profile))
                    break
        return matches

    def remove_profile(self, uid: str) -> None:
        with self._lock:
            store = self.load_all()
            store.get("profiles", {}).pop(uid, None)
            self.save_all(store)

    # --------------------------------------------------------
    # Sohbet geçmişi işlemleri (ATOMİK)
    # --------------------------------------------------------

    def get_history(self, uid: str) -> List[dict]:
        with self._lock:
            store = self.load_all()
            return list(store.get(uid, []))

    def append_history(self, uid: str, user_text: str, bot_text: str, max_turns: int = MAX_HISTORY_TURNS) -> None:
        """Bir sohbet turunu geçmişe ekler (atomik; üst sınırı aşan eski turlar kırpılır)."""
        with self._lock:
            store = self.load_all()
            history = store.setdefault(uid, [])
            history.append({"user": user_text, "bot": bot_text, "timestamp": int(time.time())})
            store[uid] = history[-max_turns:]
            self.save_all(store)

    def clear_history(self, uid: str) -> None:
        with self._lock:
            store = self.load_all()
            store.pop(uid, None)
            self.save_all(store)

    def update_history(self, uid: str, mutate: Callable[[list], Any]) -> None:
        """Geçmiş listesini kilit altında değiştirmek için."""
        with self._lock:
            store = self.load_all()
            history = store.get(uid, [])
            mutate(history)
            store[uid] = history[-MAX_HISTORY_TURNS:]
            self.save_all(store)

    # --------------------------------------------------------
    # tanılama
    # --------------------------------------------------------

    def describe(self) -> dict:
        return {
            "firebase_enabled": self._firebase_enabled,
            "firestore_mirror": bool(self._db),
            "memory_file": os.path.basename(self._memory_file)
        }


# ------------------------------------------------------------
# Modül-singılton yardımcı
# ------------------------------------------------------------

_singleton: Optional[LuminaStore] = None
_singleton_lock = threading.Lock()


def get_store(
    memory_file: str,
    firebase_enabled: bool = False,
    firestore_client: Optional[Any] = None
) -> LuminaStore:
    """Tek LuminaStore örneğini döner ( oluşturужно)."""
    global _singleton
    with _singleton_lock:
        if _singleton is None:
            _singleton = LuminaStore(memory_file, firebase_enabled, firestore_client)
        return _singleton
