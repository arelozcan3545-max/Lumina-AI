# ============================================================
# LUMINA AI - SERVER-SIDE TTS ADAPTERS
# ============================================================
# Saglayiciya ozgu adaptorler. Her adaptor:
#   1. Acik bir saglayici ses kimligi (voice_id) alir.
#   2. Istenen sesin saglayici tarafindan desteklendigini dogrular.
#   3. Ses uretir ve GERCEK saglayici/ses kimligini raporlar.
#   4. Anahtar veya hassas yapilandirma dondurmez.
#
# Istemciye donen tanilama verisi:
#   requested_provider, actual_provider, requested_voice_id,
#   actual_voice_id, profile_id, fallback, status, mime_type
#
# API anahtarlari SADECE ortam degiskenlerinden okunur ve asla
# donen sozluge/log'a yazilmaz.
# ============================================================

from __future__ import annotations

import base64
import html
import logging
import os
from typing import Any, Dict, List, Optional

import requests

from voice_registry import PROFILE_BY_ID, resolve_voice

logger = logging.getLogger("LuminaVoiceTTS")

GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize"
AZURE_TTS_TEMPLATE = "https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"

MAX_TTS_CHARS = 1200


class VoiceProviderError(Exception):
    """Ses saglayicisi hatasi (guvenli, sir icermeyen mesaj)."""


class VoiceConfigurationError(VoiceProviderError):
    """Ses saglayicisi yapilandirilmamis."""


class VoiceUnavailableError(VoiceProviderError):
    """Istenen ses kimligi saglayici tarafindan desteklenmiyor."""


def _timeout() -> float:
    try:
        return max(3.0, float(os.getenv("LUMINA_TTS_TIMEOUT_SECS", "15")))
    except (TypeError, ValueError):
        return 15.0


def _google_key() -> str:
    return (
        os.getenv("GOOGLE_TTS_API_KEY")
        or os.getenv("GOOGLE_CLOUD_TTS_API_KEY")
        or ""
    ).strip()


def _azure_key() -> str:
    return (os.getenv("AZURE_SPEECH_KEY") or "").strip()


def _azure_region() -> str:
    return (os.getenv("AZURE_SPEECH_REGION") or "").strip()


def tts_provider_status() -> Dict[str, Any]:
    """Sir icermeyen saglayici durumu."""
    return {
        "google": {"configured": bool(_google_key())},
        "azure": {"configured": bool(_azure_key() and _azure_region())},
        "browser": {"configured": True, "note": "Istemci tarafinda calisir."},
    }


def _azure_rate(rate: Optional[float]) -> str:
    if rate is None:
        return "0%"
    try:
        pct = int(round((float(rate) - 1.0) * 100))
    except (TypeError, ValueError):
        pct = 0
    pct = max(-50, min(100, pct))
    return f"{pct:+d}%"


def _synthesize_google(text: str, resolved: Dict[str, Any]) -> Dict[str, Any]:
    key = _google_key()
    if not key:
        raise VoiceConfigurationError("Google Cloud TTS yapilandirilmamis (GOOGLE_TTS_API_KEY yok).")

    voice_id = resolved.get("voice_id")
    if not voice_id:
        raise VoiceUnavailableError("Google icin ses kimligi tanimli degil.")

    payload = {
        "input": {"text": text},
        "voice": {"languageCode": "tr-TR", "name": voice_id},
        "audioConfig": {
            "audioEncoding": "MP3",
            "speakingRate": float(resolved.get("rate") or 1.0),
            # Pitch DEGISTIRILMEZ. Farkli konusmaci yalnizca farkli voice_id ile uretilir.
            "pitch": 0.0,
            "sampleRateHertz": 24000,
        },
    }

    try:
        response = requests.post(
            GOOGLE_TTS_URL,
            params={"key": key},
            json=payload,
            timeout=_timeout(),
        )
    except requests.RequestException as exc:
        raise VoiceProviderError(f"Google TTS baglanti hatasi: {type(exc).__name__}") from exc

    if response.status_code in (401, 403):
        raise VoiceProviderError("Google TTS yetki hatasi (anahtar gecersiz veya kisitli).")
    if response.status_code == 400:
        raise VoiceUnavailableError(
            f"Google TTS istegi reddedildi; '{voice_id}' sesi desteklenmiyor olabilir."
        )
    if not response.ok:
        raise VoiceProviderError(f"Google TTS HTTP {response.status_code}")

    try:
        audio_b64 = (response.json() or {}).get("audioContent") or ""
    except ValueError:
        audio_b64 = ""
    if not audio_b64:
        raise VoiceProviderError("Google TTS ses verisi dondurmedi.")

    return {
        "audio_base64": audio_b64,
        "mime_type": "audio/mpeg",
        "provider": "google",
        "voice_id": voice_id,
    }


def _synthesize_azure(text: str, resolved: Dict[str, Any]) -> Dict[str, Any]:
    key = _azure_key()
    region = _azure_region()
    if not key or not region:
        raise VoiceConfigurationError(
            "Azure Speech yapilandirilmamis (AZURE_SPEECH_KEY / AZURE_SPEECH_REGION yok)."
        )

    voice_id = resolved.get("voice_id")
    if not voice_id:
        raise VoiceUnavailableError("Azure icin ses kimligi tanimli degil.")

    ssml = (
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='tr-TR'>"
        f"<voice name='{html.escape(voice_id)}'>"
        f"<prosody rate='{_azure_rate(resolved.get('rate'))}' pitch='0%'>"
        f"{html.escape(text)}"
        "</prosody></voice></speak>"
    )

    headers = {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "LuminaAI",
    }

    try:
        response = requests.post(
            AZURE_TTS_TEMPLATE.format(region=region),
            headers=headers,
            data=ssml.encode("utf-8"),
            timeout=_timeout(),
        )
    except requests.RequestException as exc:
        raise VoiceProviderError(f"Azure TTS baglanti hatasi: {type(exc).__name__}") from exc

    if response.status_code in (401, 403):
        raise VoiceProviderError("Azure TTS yetki hatasi (anahtar/bolge gecersiz).")
    if response.status_code == 400:
        raise VoiceUnavailableError(
            f"Azure TTS istegi reddedildi; '{voice_id}' sesi desteklenmiyor olabilir."
        )
    if not response.ok:
        raise VoiceProviderError(f"Azure TTS HTTP {response.status_code}")

    content = response.content or b""
    if not content:
        raise VoiceProviderError("Azure TTS ses verisi dondurmedi.")

    return {
        "audio_base64": base64.b64encode(content).decode("ascii"),
        "mime_type": "audio/mpeg",
        "provider": "azure",
        "voice_id": voice_id,
    }


_SUPPORTED_PROVIDERS = ("google", "azure")


def synthesize_speech(
    text: str,
    profile_id: str,
    provider: Optional[str] = None,
    allow_fallback: bool = True,
) -> Dict[str, Any]:
    """Istenen profil icin sunucu tarafinda ses uretir.

    `provider` acikca verilirse once o denenir. Basarisiz olursa ve
    `allow_fallback` True ise diger yapilandirilmis saglayici denenir.
    Bu durum `fallback: True` ve `fallback_reason` ile ACIKCA raporlanir;
    sessizce farkli konusmaciya gecildigi asla iddia edilmez.
    """
    clean = (text or "").strip()
    if not clean:
        raise VoiceProviderError("Seslendirilecek metin bos olamaz.")
    if len(clean) > MAX_TTS_CHARS:
        clean = clean[:MAX_TTS_CHARS]

    profile = PROFILE_BY_ID.get(profile_id)
    if not profile:
        raise VoiceUnavailableError(f"Bilinmeyen ses profili: {profile_id}")

    requested_provider = (provider or "").strip().lower() or None
    if requested_provider and requested_provider not in _SUPPORTED_PROVIDERS:
        raise VoiceConfigurationError(
            f"'{requested_provider}' sunucu tarafinda ses sentezini desteklemiyor."
        )

    order: List[str] = []
    if requested_provider:
        order.append(requested_provider)
    for pid in _SUPPORTED_PROVIDERS:
        if pid not in order:
            order.append(pid)

    errors: List[str] = []
    for pid in order:
        resolved = resolve_voice(profile_id, pid)
        if not resolved:
            errors.append(f"{pid}: yapilandirilmamis veya ses tanimli degil")
            continue
        try:
            if pid == "google":
                result = _synthesize_google(clean, resolved)
            elif pid == "azure":
                result = _synthesize_azure(clean, resolved)
            else:  # pragma: no cover - savunma amacli
                continue
        except VoiceProviderError as exc:
            errors.append(f"{pid}: {exc}")
            logger.warning("TTS saglayicisi basarisiz (%s / %s): %s", profile_id, pid, exc)
            if not allow_fallback:
                raise
            continue

        fallback = bool(requested_provider and pid != requested_provider)
        return {
            "success": True,
            "profile_id": profile_id,
            "profile_name": profile.get("name"),
            "requested_provider": requested_provider,
            "actual_provider": pid,
            "provider": pid,
            "requested_voice_id": (
                (resolve_voice(profile_id, requested_provider) or {}).get("voice_id")
                if requested_provider else None
            ),
            "actual_voice_id": result["voice_id"],
            "voice_id": result["voice_id"],
            "audio_base64": result["audio_base64"],
            "mime_type": result["mime_type"],
            "fallback": fallback,
            "fallback_reason": "; ".join(errors) if fallback else None,
            "status": "generated",
            "characters": len(clean),
        }

    raise VoiceProviderError(
        "Hicbir bulut TTS saglayicisi kullanilamadi. "
        + ("; ".join(errors) if errors else "Saglayici yapilandirilmamis.")
    )
