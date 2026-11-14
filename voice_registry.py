# ============================================================
# LUMINA AI - VOICE REGISTRY (SES KAYIT DEFTERI)
# ============================================================
# Tek dogruluk kaynagi. Her ses profili gercek bir saglayici ses
# kimligine baglidir. Ayni saglayici ses kimligi iki farkli profile
# atanamaz; bu, "farkli gorunen ama ayni konusan" sesleri engeller.
#
# Dogrulanmis ses kimlikleri:
#   Google Cloud TTS (tr-TR):
#     Standard-A (K), B (E), C (K), D (K), E (E)
#     Wavenet-A (K), B (E), C (K), D (K), E (E)
#   Microsoft Azure Speech (tr-TR):
#     EmelNeural (K), AhmetNeural (E)
#
# Ucretlendirme:
#   Google Cloud TTS: karakter bazli (ucretli; ilk 1M karakter/ay
#     WaveNet disinda ucretsiz kota saglayici tarafindan degisebilir).
#   Azure Speech: neural sesler icin ucretli; ucretsiz katman aylik
#     sinirli sure tanir.
#   Tarayici SpeechSynthesis: ucretsiz, ancak ses envanteri cihaza
#     ve isletim sistemine baglidir.
#
# Saglayici anahtarlari ASLA istemciye gonderilmez; yalnizca
# "configured" boolean'i raporlanir.
# ============================================================

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

# ------------------------------------------------------------
# Profil tanimlari
# ------------------------------------------------------------

VOICE_PROFILES: List[Dict[str, Any]] = [
    {
        "id": "jenna",
        "name": "Jenna",
        "gender": "female",
        "persona": "Canli, Tatli & Neseli",
        "description": "Enerjik ve sicak kadin sesi.",
        "rate": 1.05,
        "preview_text": "Merhaba! Ben Jenna. Civil civil ve enerjik bir kadin sesiyim. Seninle sohbet etmek harika!",
        "providers": {
            "google": {"voice_id": "tr-TR-Wavenet-A", "label": "Aylin (WaveNet)"},
            "azure": {"voice_id": "tr-TR-EmelNeural", "label": "Emel (Neural)"},
            "browser": {"gender": "female", "preferred_names": ["emel", "aylin", "filiz", "yelda", "google turkce", "google türkçe"]},
        },
    },
    {
        "id": "emma",
        "name": "Emma",
        "gender": "female",
        "persona": "Sakin, Sicak & Huzurlu",
        "description": "Sakin ve dinlendirici kadin sesi.",
        "rate": 0.92,
        "preview_text": "Selam. Ben Emma. Sakin, dinlendirici ve huzurlu bir kadin sesiyim. Aklinizdakileri rahatca paylasabilirsiniz.",
        "providers": {
            "google": {"voice_id": "tr-TR-Wavenet-C", "label": "Berna (WaveNet)"},
            "browser": {"gender": "female", "preferred_names": ["filiz", "berna", "yelda", "emel"]},
        },
    },
    {
        "id": "elif",
        "name": "Elif",
        "gender": "female",
        "persona": "Akici & Dogal Turkce",
        "description": "Net diksiyonlu, akici kadin sesi.",
        "rate": 1.0,
        "preview_text": "Merhaba, ben Elif! Cok net, berrak ve akici bir Turkce diksiyonuyla size yardimci olmaktan mutluluk duyarim.",
        "providers": {
            "google": {"voice_id": "tr-TR-Wavenet-D", "label": "Basak (WaveNet)"},
            "browser": {"gender": "female", "preferred_names": ["basak", "başak", "dilara", "zeynep"]},
        },
    },
    {
        "id": "tommy",
        "name": "Tommy",
        "gender": "male",
        "persona": "Dinamik, Genc & Hizli",
        "description": "Enerjik ve genc erkek sesi.",
        "rate": 1.08,
        "preview_text": "Selam dostum! Ben Tommy. Hizli, dinamik ve enerjik bir erkek sesiyim. Hadi hemen baslayalim!",
        "providers": {
            "google": {"voice_id": "tr-TR-Wavenet-B", "label": "Berat (WaveNet)"},
            "azure": {"voice_id": "tr-TR-AhmetNeural", "label": "Ahmet (Neural)"},
            "browser": {"gender": "male", "preferred_names": ["tolga", "berat", "ahmet", "cem", "can"]},
        },
    },
    {
        "id": "david",
        "name": "David",
        "gender": "male",
        "persona": "Tok, Karizmatik & Derin",
        "description": "Tok ve derin erkek sesi.",
        "rate": 0.94,
        "preview_text": "Iyi gunler. Ben David. Tok, derin ve net bir erkek sesiyle analitik cozumlerde yaninizdayim.",
        "providers": {
            "google": {"voice_id": "tr-TR-Wavenet-E", "label": "Omer (WaveNet)"},
            "browser": {"gender": "male", "preferred_names": ["omer", "ömer", "cem", "baris", "barış"]},
        },
    },
    {
        "id": "baris",
        "name": "Baris",
        "gender": "male",
        "persona": "Samimi & Dogal Erkek",
        "description": "Samimi, arkadas canlisi erkek sesi.",
        "rate": 1.0,
        "preview_text": "Selam! Ben Baris. Tipki karsilikli konusan yakin bir arkadasiniz gibi dogal ve samimi bir erkek sesiyim.",
        "providers": {
            "google": {"voice_id": "tr-TR-Standard-B", "label": "Ahmet (Standard)"},
            "browser": {"gender": "male", "preferred_names": ["ahmet", "tolga", "can", "erkek"]},
        },
    },
]

PROFILE_BY_ID: Dict[str, Dict[str, Any]] = {p["id"]: p for p in VOICE_PROFILES}

PROVIDERS: Dict[str, Dict[str, Any]] = {
    "google": {
        "id": "google",
        "name": "Google Cloud Text-to-Speech",
        "description": "Yuksek kaliteli WaveNet/Standard Turkce sesler. Sunucu tarafinda API anahtari gerektirir.",
        "languages": ["tr-TR"],
        "platforms": ["desktop", "mobile"],
        "cost": "pay-as-you-go",
        "env_vars": ["GOOGLE_TTS_API_KEY"],
    },
    "azure": {
        "id": "azure",
        "name": "Microsoft Azure AI Speech",
        "description": "Neural Turkce sesler. Azure aboneligi ve bolge bilgisi gerektirir.",
        "languages": ["tr-TR"],
        "platforms": ["desktop", "mobile"],
        "cost": "pay-as-you-go / free tier",
        "env_vars": ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"],
    },
    "browser": {
        "id": "browser",
        "name": "Tarayici SpeechSynthesis",
        "description": "Ucretsiz, kurulum gerektirmez. Ses envanteri cihaza gore degisir.",
        "languages": ["tr-TR"],
        "platforms": ["desktop", "mobile"],
        "cost": "free",
        "env_vars": [],
    },
}


# ------------------------------------------------------------
# Saglayici yapilandirma durumu
# ------------------------------------------------------------

def provider_configured(provider: str) -> bool:
    if provider == "browser":
        return True
    if provider == "google":
        return bool((os.getenv("GOOGLE_TTS_API_KEY") or os.getenv("GOOGLE_CLOUD_TTS_API_KEY") or "").strip())
    if provider == "azure":
        return bool((os.getenv("AZURE_SPEECH_KEY") or "").strip()) and bool(
            (os.getenv("AZURE_SPEECH_REGION") or "").strip()
        )
    return False


def provider_configuration() -> Dict[str, bool]:
    return {pid: provider_configured(pid) for pid in PROVIDERS}


def get_profile(profile_id: str) -> Optional[Dict[str, Any]]:
    """Profil kimligine gore kayit defteri kaydini dondurur."""
    return PROFILE_BY_ID.get(profile_id)


def resolve_voice(profile_id: str, provider: str) -> Optional[Dict[str, Any]]:
    """Profil + saglayici icin gercek ses kimligini doner; yoksa None.

    Tarayici saglayicisinda ses kimligi calisma zamaninda cozulur;
    burada yalnizca tercih kurallari doner.
    """
    profile = PROFILE_BY_ID.get(profile_id)
    if not profile:
        return None
    entry = (profile.get("providers") or {}).get(provider)
    if not entry:
        return None
    if provider != "browser" and not provider_configured(provider):
        return None
    return {
        "profile_id": profile_id,
        "provider": provider,
        "voice_id": entry.get("voice_id"),
        "label": entry.get("label"),
        "gender": entry.get("gender") or profile.get("gender"),
        "preferred_names": entry.get("preferred_names") or [],
        "rate": profile.get("rate", 1.0),
    }


def voice_catalog() -> Dict[str, Any]:
    """Istemci icin sir icermeyen katalog."""
    config = provider_configuration()
    providers = []
    for pid, meta in PROVIDERS.items():
        providers.append({
            "id": pid,
            "name": meta["name"],
            "description": meta["description"],
            "languages": meta["languages"],
            "platforms": meta["platforms"],
            "cost": meta["cost"],
            "configured": bool(config.get(pid)),
            "requires_server_key": pid != "browser",
        })

    profiles = []
    for profile in VOICE_PROFILES:
        available_providers = []
        for pid in PROVIDERS:
            resolved = resolve_voice(profile["id"], pid)
            if resolved:
                available_providers.append({
                    "provider": pid,
                    "voice_id": resolved.get("voice_id"),
                    "label": resolved.get("label") or "Cihaz sesi",
                })
        profiles.append({
            "id": profile["id"],
            "name": profile["name"],
            "gender": profile["gender"],
            "persona": profile["persona"],
            "description": profile["description"],
            "preview_text": profile["preview_text"],
            "rate": profile.get("rate", 1.0),
            "providers": available_providers,
        })

    return {
        "success": True,
        "profiles": profiles,
        "providers": providers,
        "default_provider": next(
            (pid for pid in ("google", "azure", "browser") if config.get(pid)), "browser"
        ),
    }


def validate_registry() -> List[str]:
    """Kayit defterindeki yinelenen ses kimliklerini ve eksik alanlari denetler."""
    errors: List[str] = []
    seen_ids = set()
    seen_provider_voices: Dict[str, str] = {}
    for profile in VOICE_PROFILES:
        pid = profile.get("id")
        if not pid:
            errors.append("Profil kimligi eksik.")
            continue
        if pid in seen_ids:
            errors.append(f"Yinelenen profil kimligi: {pid}")
        seen_ids.add(pid)
        if not (profile.get("preview_text") or "").strip():
            errors.append(f"{pid}: onizleme metni eksik.")
        for provider, entry in (profile.get("providers") or {}).items():
            voice_id = (entry or {}).get("voice_id")
            if not voice_id:
                continue
            combo = f"{provider}:{voice_id}"
            if combo in seen_provider_voices:
                errors.append(
                    f"Yinelenen saglayici sesi: {combo} ({seen_provider_voices[combo]} ve {pid})"
                )
            else:
                seen_provider_voices[combo] = pid
    return errors


_REGISTRY_ERRORS = validate_registry()
