# ============================================================
# LUMINA AI - GÜVENLİ API ANAHTAR ATAMA ROUTER'I
# ============================================================
# ÖNEMLİ GÜVENLİK NOTU:
#   Bu router eskiden istemciden gelen `uid` parametresini doğrulamadan
#   kabul ediyor ve atanan Groq API anahtarının KENDİSİNİ HTTP yanıtında
#   döndürüyordu. Bu, anahtar hırsızlığına ve hesap taklidine açık bir
#   güvenlik açığıydı.
#
#   Yeni sürüm:
#     - Kullanıcı kimliği YALNIZCA doğrulanmış oturumdan alınır.
#     - İstemciye asla tam anahtar dönmez; yalnızca maskeli özet döner.
#     - Router, `main.py`'nin `verify_token` bağımlılığı enjekte edilerek
#       kurulur (dairesel import yok).
#
#   main.py zaten `/api/v1/keys/me` ve `/api/v1/keys/assign`
#   endpoint'lerini içerir. Bu router geriye uyumluluk için opsiyoneldir.
# ============================================================

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException

from api_allocation import ensure_assignment, get_assignment, pool_status, public_assignment


def build_assignment_router(verify_token: Callable[..., Dict[str, Any]]) -> APIRouter:
    """Doğrulanmış kimlik bağımlılığıyla güvenli atama router'ı üretir.

    `verify_token`, `Authorization: Bearer <token>` başlığını doğrulayıp
    kullanıcı sözlüğü döndüren bir FastAPI bağımlılığı olmalıdır.
    """
    if not callable(verify_token):
        raise TypeError("verify_token çağrılabilir bir bağımlılık olmalıdır.")

    router = APIRouter(tags=["api-keys"])

    def _is_eligible(user: Optional[dict]) -> bool:
        if not user:
            return False
        if user.get("firebase"):
            return True
        uid = str(user.get("uid") or "")
        if user.get("guest"):
            return False
        return bool(uid) and uid not in ("guest_user", "local_user") and not uid.startswith("guest_")

    @router.post("/assign_api")
    def assign_api(user: dict = Depends(verify_token)):
        """Kullanıcıya (varsa aynı) havuz anahtarını atar.

        Yanıt yalnızca `key_id`, `masked_key` ve durum bilgisini içerir.
        Anahtarın kendisi ASLA dönmez.
        """
        if not _is_eligible(user):
            raise HTTPException(
                status_code=403,
                detail="API anahtar havuzu yalnızca doğrulanmış hesaplara açıktır.",
            )

        uid = str(user.get("uid"))
        existing = get_assignment(uid)
        if existing:
            return {"success": True, **public_assignment(uid)}

        assignment = ensure_assignment(uid)
        if not assignment:
            raise HTTPException(
                status_code=429,
                detail=(
                    "Şu anda tüm yapay zeka API kapasiteleri dolu. Kotanız tükenmedi; "
                    "lütfen daha sonra tekrar deneyin veya kendi API anahtarınızı ekleyin."
                ),
            )
        return {"success": True, **public_assignment(uid)}

    @router.get("/user_api_key")
    def get_user_api_key_summary(user: dict = Depends(verify_token)):
        """Kullanıcının atanmış anahtar ÖZETİNİ döner (tam anahtar değil)."""
        if not _is_eligible(user):
            raise HTTPException(
                status_code=403,
                detail="API anahtar havuzu yalnızca doğrulanmış hesaplara açıktır.",
            )

        uid = str(user.get("uid"))
        payload = public_assignment(uid)
        if not payload.get("assigned"):
            raise HTTPException(
                status_code=404,
                detail="Kullanıcıya atanmış bir API anahtarı bulunamadı.",
            )
        return {"success": True, **payload}

    @router.get("/pool_status")
    def get_pool_status(user: dict = Depends(verify_token)):
        """Havuz kapasitesi (sır içermez). Yönetici token'ı ayrı uçta tutulur."""
        if not _is_eligible(user):
            raise HTTPException(
                status_code=403,
                detail="Havuz durumu yalnızca doğrulanmış hesaplara açıktır.",
            )
        status = pool_status()
        return {
            "success": True,
            "configured_keys": status["configured_keys"],
            "max_keys": status["max_keys"],
            "max_users_per_key": status["max_users_per_key"],
            "total_capacity": status["total_capacity"],
            "available_slots": status["available_slots"],
        }

    return router
