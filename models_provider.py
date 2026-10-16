# ============================================================
# LUMINA AI - MODEL PROVIDER ABSTRACTION LAYER (v3.1)
# Google Gemini (Resmi API) + Groq + GitHub Models
# Kurumsal Kaskad, Akıllı Yönlendirme ve Dayanıklılık Motoru
#
# ONARIM NOTU (16 Ekim 2026):
#   Eski katalogdaki tüm model kimlikleri kapanmıştı ve "Groq 404"
#   hatasının kök nedeniydi:
#     - mixtral-8x7b-32768          (kapanış: 20.03.2025)
#     - llama-3.3-70b-versatile     (kapanış: 16.08.2026, yalnızca Enterprise)
#     - llama-3.1-8b-instant        (kapanış: 16.08.2026, yalnızca Enterprise)
#     - gemini-2.0-flash / gemini-1.5-pro  (404 kaynaklı)
#   Bu katman, DOĞRULANMIŞ GÜNCEL modellerle yeniden kurulmuştur.
# ============================================================

import os
import json
import time
import logging
import threading
import requests
from typing import List, Dict, Any, Optional, Generator, Callable, Tuple

logger = logging.getLogger("LuminaModelProvider")

# ============================================================
# ORTAM DEĞİŞKENLERİ & UÇ NOKTALAR
# ============================================================

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "").strip() or os.getenv("GITHUB_API_KEY", "").strip()

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
# GitHub Models: yeni uç nokta birincil; eski Azure ucu yedek kaskad olarak korunur.
GITHUB_MODELS_URL_NEW = "https://models.github.ai/inference/chat/completions"
GITHUB_MODELS_URL_LEGACY = "https://models.inference.ai.azure.com/chat/completions"
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"

# ============================================================
# DOĞRULANMIŞ GÜNCEL MODEL KATALOĞU (16 Ekim 2026)
# ============================================================

# Google Gemini — güncel metin modelleri
GEMINI_MODEL_FLAGSHIP = "gemini-4-argon"        # Amiral gemisi (en güçlü)
GEMINI_MODEL_HIGH = "gemini-3.8-flash"          # Üst seviye Flash (flagship yedeği)
GEMINI_MODEL_PRO = "gemini-3.6-flash"           # Pro segment
GEMINI_MODEL_STANDARD = "gemini-3.5-flash-lite" # Standart segment (hızlı/verimli)
GEMINI_MODEL_LITE = "gemini-3.1-flash-lite"     # Ekonomi segment

# Groq — güncel üretim modelleri
GROQ_MODEL_FLAGSHIP = "openai/gpt-oss-120b"     # En güçlü Groq modeli
GROQ_MODEL_STANDARD = "openai/gpt-oss-20b"      # Hızlı ve verimli
GROQ_MODEL_PREVIEW = "qwen/qwen3.8-27b"         # Önizleme alternatifi

# GitHub Models — kuruluş öneki ZORUNLU (yeni uç nokta)
GITHUB_MODEL_PRO = "openai/gpt-4o"
GITHUB_MODEL_STANDARD = "openai/gpt-4o-mini"

# Gemini resim üretimi (REST interactions uç noktası)
GEMINI_IMAGE_MODEL = "gemini-nano-banana-2.1"
GEMINI_IMAGE_MODEL_BACKUP = "gemini-3.1-flash-lite-image"

# Kimlik doğrulama hatası sonrası sağlayıcıyı zamansal olarak kapama
_AUTH_DISABLED_PROVIDERS: Dict[str, float] = {}
_AUTH_DISABLED_TTL = 15 * 60  # 15 dakika sonra yeniden denenir
_AUTH_DISABLE_LOCK = threading.Lock()

# ============================================================
# TÜRKÇE HATA TAKSONOMİSİ
# ============================================================

class ProviderError(Exception):
    """Tüm sağlayıcı hatalarının kök sınıfı. `kind` alanı kaskad davranışını belirler:
    - "transient": geçici hata (429, 5xx, ağ) → üstel bekleyip yeniden dene, sonra atla
    - "model_gone": 404 model bulunamadı → yeniden deneme YAPMA, doğrudan sonraki adaya geç
    - "auth": 401/403 yetki hatası → sağlayıcıyı sürecin kalanında kısa süreliğine kapat, sonrakine geç
    """
    kind = "transient"

    def __init__(self, message: str, provider: str = "", model: str = "", status: Optional[int] = None):
        super().__init__(message)
        self.provider = provider
        self.model = model
        self.status = status


class ProviderConfigurationError(ProviderError):
    """API anahtarı hiç yapılandırılmamış. Yeniden deneme anlamsızdır."""
    kind = "config"


class ProviderAuthError(ProviderError):
    """401/403: anahtar geçersiz, süresi dolmuş veya yetkisiz."""
    kind = "auth"


class ProviderModelUnavailableError(ProviderError):
    """404: model kimliği yok / kapanmış / bu hesapta kullanılamıyor."""
    kind = "model_gone"


class ProviderRateLimitError(ProviderError):
    """429: kota/istek limiti. Geri çekilme (backoff) ile tekrar denenebilir."""
    kind = "transient"


class ProviderUnavailableError(ProviderError):
    """5xx, zaman aşımı, bağlantı hatası. Geçici — tekrar denenebilir/atlanabilir."""
    kind = "transient"


class ContentSafetyProviderError(ProviderError):
    """İçerik güvenlik filtresine takılma. Sonraki modelle denenebilir."""
    kind = "content_filter"


def _classify_provider_http_error(provider: str, model: str, status: int, body_text: str) -> ProviderError:
    """HTTP durum kodunu Türkçe hata taksonomisine çevirir."""
    snippet = (body_text or "")[:300]
    base = f"{provider} API hatası (HTTP {status}, model={model}): {snippet}"

    if status in (401, 403):
        human = (
            f"{provider} referansı reddedildi (HTTP {status}). Anahtar geçersiz olabilir, "
            f"süresi dolmuş olabilir veya bu model için yetkiniz bulunmuyor. Model: {model}"
        )
        return ProviderAuthError(human, provider=provider, model=model, status=status)
    if status == 404:
        human = (
            f"{provider} bu modeli sunmuyor veya model kimliği geçersiz (HTTP 404): '{model}'. "
            "Kaskad bir sonraki model ile devam ediyor."
        )
        return ProviderModelUnavailableError(human, provider=provider, model=model, status=status)
    if status == 429:
        human = f"{provider} hız/sınırlama kotası doldu (HTTP 429), model={model}"
        return ProviderRateLimitError(human, provider=provider, model=model, status=status)
    if 400 <= status < 500:
        human = f"{provider} isteği reddetti (HTTP {status}, model={model}): {snippet}"
        return ProviderUnavailableError(human, provider=provider, model=model, status=status)
    human = f"{provider} sunucusu geçici olarak kullanılamıyor (HTTP {status}, model={model}): {snippet}"
    return ProviderUnavailableError(human, provider=provider, model=model, status=status)


def _disable_provider_temporarily(provider: str):
    """Yetki hatasında sağlayıcıyı 15 dakika süreyle devre dışı bırakır (tekrar eden 401/403 bombardımanını önler)."""
    with _AUTH_DISABLE_LOCK:
        _AUTH_DISABLED_PROVIDERS[provider] = time.time()


def _is_provider_auth_disabled(provider: str) -> bool:
    with _AUTH_DISABLE_LOCK:
        disabled_at = _AUTH_DISABLED_PROVIDERS.get(provider)
    if disabled_at is None:
        return False
    if time.time() - disabled_at > _AUTH_DISABLED_TTL:
        with _AUTH_DISABLE_LOCK:
            _AUTH_DISABLED_PROVIDERS.pop(provider, None)
        return False
    return True


# ============================================================
# KÜÇÜK YARDIMCILAR
# ============================================================

REQUEST_TIMEOUT_SECS = 55
STREAM_TIMEOUT_SECS = 90
BACKOFF_BASE_SECS = 0.8      # Üstel geri çekilme tabanı
BACKOFF_MAX_RETRIES = 2      # Geçici hata başına deneme sayısı
BACKOFF_CAP_SECS = 6.0

def _retry_delay(attempt: int) -> float:
    """Üstel geri çekilme: 0.8s → 1.6s → 3.2s (tavan 6s)."""
    delay = BACKOFF_BASE_SECS * (2 ** attempt)
    return min(delay, BACKOFF_CAP_SECS)


def _sleep_backoff(attempt: int):
    time.sleep(_retry_delay(attempt))


# ============================================================
# 1. GOOGLE GEMINI PROVIDER
# ============================================================

def format_messages_for_gemini(messages: List[Dict[str, str]]) -> Tuple[Optional[str], List[Dict[str, Any]]]:
    """OpenAI tarzı mesaj listesini Gemini contents & systemInstruction formatına çevirir."""
    system_instruction = None
    gemini_contents = []

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if role == "system":
            if system_instruction:
                system_instruction += "\n\n" + content
            else:
                system_instruction = content
        elif role in ("assistant", "bot"):
            gemini_contents.append({
                "role": "model",
                "parts": [{"text": content}]
            })
        else:  # user
            gemini_contents.append({
                "role": "user",
                "parts": [{"text": content}]
            })

    return system_instruction, gemini_contents


def _gemini_headers(api_key: str) -> Dict[str, str]:
    # Anahtar URL yerine başlıkta taşınır (loglarda/sunucu kayıtlarında sızmaz)
    return {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key
    }


def call_gemini(
    messages: List[Dict[str, str]],
    model: str = GEMINI_MODEL_HIGH,
    temperature: float = 0.65,
    max_tokens: int = 4096,
    custom_api_key: Optional[str] = None
) -> str:
    """Google Gemini Resmi API Çağrısı (v1beta generateContent)."""
    api_key = (custom_api_key or GEMINI_API_KEY).strip()
    if not api_key:
        raise ProviderConfigurationError("Google Gemini API anahtarı yapılandırılmamış.")

    system_instruction, contents = format_messages_for_gemini(messages)
    url = f"{GEMINI_BASE_URL}/{model}:generateContent"

    payload: Dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
            "topP": 0.95
        }
    }
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

    last_exc: Optional[ProviderError] = None
    for attempt in range(BACKOFF_MAX_RETRIES + 1):
        try:
            res = requests.post(
                url,
                json=payload,
                headers=_gemini_headers(api_key),
                timeout=REQUEST_TIMEOUT_SECS
            )
            err_exc = _classify_provider_http_error("Gemini", model, res.status_code, res.text) if not res.ok else None
            if err_exc is not None:
                if err_exc.kind == "auth":
                    _disable_provider_temporarily("gemini")
                last_exc = err_exc
                if err_exc.kind == "transient" and attempt < BACKOFF_MAX_RETRIES:
                    logger.warning(f"Gemini ({model}) geçici hata, {attempt + 1}. deneme başarısız: {err_exc}")
                    _sleep_backoff(attempt)
                    continue
                raise err_exc

            data = res.json()
            candidates = data.get("candidates", [])
            if not candidates:
                prompt_feedback = data.get("promptFeedback", {})
                if prompt_feedback.get("blockReason"):
                    raise ContentSafetyProviderError(
                        f"İçerik güvenlik filtresine takıldı: {prompt_feedback.get('blockReason')}",
                        provider="gemini", model=model
                    )
                raise ProviderUnavailableError("Gemini geçerli bir yanıt adayı üretmedi.", provider="gemini", model=model)

            content_obj = candidates[0].get("content", {})
            parts = content_obj.get("parts", [])
            full_text = "".join(p.get("text", "") for p in parts if "text" in p).strip()

            if not full_text:
                raise ProviderUnavailableError("Gemini boş metin yanıtı döndürdü.", provider="gemini", model=model)

            return full_text

        except requests.exceptions.RequestException as exc:
            last_exc = ProviderUnavailableError(
                f"Gemini'ye bağlanırken ağ hatası oluştu: {exc}", provider="gemini", model=model
            )
            if attempt < BACKOFF_MAX_RETRIES:
                _sleep_backoff(attempt)
                continue
            raise last_exc

    raise last_exc or ProviderUnavailableError("Gemini çağrısı tamamlanamadı.", provider="gemini", model=model)


def stream_gemini(
    messages: List[Dict[str, str]],
    model: str = GEMINI_MODEL_HIGH,
    temperature: float = 0.65,
    max_tokens: int = 4096,
    custom_api_key: Optional[str] = None
) -> Generator[str, None, None]:
    """Google Gemini SSE Canlı Yanıt Akışı (streamGenerateContent alt=sse)."""
    api_key = (custom_api_key or GEMINI_API_KEY).strip()
    if not api_key:
        raise ProviderConfigurationError("Google Gemini API anahtarı yapılandırılmamış.")

    system_instruction, contents = format_messages_for_gemini(messages)
    url = f"{GEMINI_BASE_URL}/{model}:streamGenerateContent?alt=sse"

    payload: Dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens
        }
    }
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

    try:
        with requests.post(url, json=payload, headers=_gemini_headers(api_key), stream=True, timeout=STREAM_TIMEOUT_SECS) as resp:
            if not resp.ok:
                exc = _classify_provider_http_error("Gemini", model, resp.status_code, resp.text[:300])
                if exc.kind == "auth":
                    _disable_provider_temporarily("gemini")
                raise exc

            for line in resp.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk_json = json.loads(data_str)
                    cands = chunk_json.get("candidates", [])
                    if cands:
                        parts = cands[0].get("content", {}).get("parts", [])
                        for part in parts:
                            text = part.get("text", "")
                            if text:
                                yield text
                except Exception:
                    continue
    except requests.exceptions.RequestException as exc:
        raise ProviderUnavailableError(f"Gemini akış bağlantısı koptu: {exc}", provider="gemini", model=model)


# Gemini Nano Banana resim üretimi (REST interactions)
def call_gemini_image(
    prompt: str,
    aspect_ratio: str = "1:1",
    custom_api_key: Optional[str] = None,
    model: str = GEMINI_IMAGE_MODEL
) -> Dict[str, Any]:
    """Gemini Nano Banana ile resim üretir (v1beta/interactions, store:false).

    Dönen değer: {"image_base64": ..., "mime_type": ...} veya {"image_url": ...}
    """
    api_key = (custom_api_key or GEMINI_API_KEY).strip()
    if not api_key:
        raise ProviderConfigurationError("Google Gemini API anahtarı yapılandırılmamış.")

    payload: Dict[str, Any] = {
        "model": model,
        "input": prompt,
        "response_format": {
            "type": "image",
            "aspect_ratio": aspect_ratio,
            "image_size": "2K"
        },
        "store": False  # Kalıcı saklama / model eğitim kullanımı yok
    }

    for attempt in range(BACKOFF_MAX_RETRIES + 1):
        try:
            res = requests.post(
                GEMINI_INTERACTIONS_URL,
                json=payload,
                headers=_gemini_headers(api_key),
                timeout=REQUEST_TIMEOUT_SECS + 30  # görsel üretimi daha yavaş
            )
            if not res.ok:
                exc = _classify_provider_http_error("Gemini-Görsel", model, res.status_code, res.text)
                if exc.kind == "auth":
                    _disable_provider_temporarily("gemini")
                if exc.kind == "transient" and attempt < BACKOFF_MAX_RETRIES:
                    _sleep_backoff(attempt)
                    continue
                raise exc

            data = res.json()
            # Yanıtlar: output_image / inlineData(inline_data)/ base64 alanlarında olabilir
            image_b64 = data.get("output_image")
            if not image_b64:
                contents = data.get("outputs") or data.get("output") or []
                for item in contents if isinstance(contents, list) else [contents]:
                    if not isinstance(item, dict):
                        continue
                    inline = item.get("inline_data") or item.get("inlineData") or item.get("data") or {}
                    if isinstance(inline, dict) and inline.get("data"):
                        image_b64 = inline["data"]
                        break
            if not image_b64:
                raise ProviderUnavailableError("Gemini görsel yanıtı görüntü verisi içermedi.", provider="gemini", model=model)

            mime = (data.get("mime_type") or data.get("image_mime_type") or "image/png")
            return {"image_base64": image_b64 if isinstance(image_b64, str) else str(image_b64), "mime_type": mime}

        except requests.exceptions.RequestException as exc:
            exc2 = ProviderUnavailableError(
                f"Gemini görsel üretim bağlantısı başarısız: {exc}", provider="gemini", model=model
            )
            if attempt < BACKOFF_MAX_RETRIES:
                _sleep_backoff(attempt)
                continue
            raise exc2

    raise ProviderUnavailableError("Gemini görsel üretimi tamamlanamadı.", provider="gemini", model=model)


# ============================================================
# 2. GROQ PROVIDER
# ============================================================

def call_groq(
    messages: List[Dict[str, str]],
    model: str = GROQ_MODEL_FLAGSHIP,
    temperature: float = 0.65,
    max_tokens: int = 4096,
    custom_api_key: Optional[str] = None
) -> str:
    """Groq LPU Ultra Hızlı API Çağrısı."""
    api_key = (custom_api_key or GROQ_API_KEY).strip()
    if not api_key:
        raise ProviderConfigurationError("Groq API anahtarı yapılandırılmamış.")

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    last_exc: Optional[ProviderError] = None
    for attempt in range(BACKOFF_MAX_RETRIES + 1):
        try:
            res = requests.post(GROQ_URL, json=payload, headers=headers, timeout=REQUEST_TIMEOUT_SECS)
            if not res.ok:
                err_exc = _classify_provider_http_error("Groq", model, res.status_code, res.text)
                if err_exc.kind == "auth":
                    _disable_provider_temporarily("groq")
                last_exc = err_exc
                if err_exc.kind == "transient" and attempt < BACKOFF_MAX_RETRIES:
                    logger.warning(f"Groq ({model}) geçici hata, {attempt + 1}. deneme başarısız: {err_exc}")
                    _sleep_backoff(attempt)
                    continue
                raise err_exc

            data = res.json()
            choices = data.get("choices", [])
            if not choices:
                raise ProviderUnavailableError("Groq seçim (choice) döndürmedi.", provider="groq", model=model)

            content = choices[0].get("message", {}).get("content", "").strip()
            if not content:
                raise ProviderUnavailableError("Groq boş metin yanıtı döndürdü.", provider="groq", model=model)
            return content

        except requests.exceptions.RequestException as exc:
            last_exc = ProviderUnavailableError(f"Groq'a bağlanırken ağ hatası oluştu: {exc}", provider="groq", model=model)
            if attempt < BACKOFF_MAX_RETRIES:
                _sleep_backoff(attempt)
                continue
            raise last_exc

    raise last_exc or ProviderUnavailableError("Groq çağrısı tamamlanamadı.", provider="groq", model=model)


def stream_groq(
    messages: List[Dict[str, str]],
    model: str = GROQ_MODEL_FLAGSHIP,
    temperature: float = 0.65,
    max_tokens: int = 4096,
    custom_api_key: Optional[str] = None
) -> Generator[str, None, None]:
    """Groq SSE Akış Çağrısı."""
    api_key = (custom_api_key or GROQ_API_KEY).strip()
    if not api_key:
        raise ProviderConfigurationError("Groq API anahtarı yapılandırılmamış.")

    try:
        with requests.post(
            GROQ_URL,
            json={
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "stream": True
            },
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            stream=True,
            timeout=STREAM_TIMEOUT_SECS
        ) as resp:
            if not resp.ok:
                exc = _classify_provider_http_error("Groq", model, resp.status_code, resp.text[:300])
                if exc.kind == "auth":
                    _disable_provider_temporarily("groq")
                raise exc

            for line in resp.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                    choices = chunk.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content
                except Exception:
                    continue
    except requests.exceptions.RequestException as exc:
        raise ProviderUnavailableError(f"Groq akış bağlantısı koptu: {exc}", provider="groq", model=model)


# ============================================================
# 3. GITHUB MODELS PROVIDER
# ============================================================

def call_github_models(
    messages: List[Dict[str, str]],
    model: str = GITHUB_MODEL_STANDARD,
    temperature: float = 0.65,
    max_tokens: int = 4096,
    custom_token: Optional[str] = None
) -> str:
    """GitHub Models API Çağrısı.

    Birincil uç: https://models.github.ai/inference/chat/completions (kuruluş öneki zorunlu, örn. openai/gpt-4o-mini)
    Yedek uç:    https://models.inference.ai.azure.com/chat/completions (öneki siz model kimliği)
    """
    token = (custom_token or GITHUB_TOKEN).strip()
    if not token:
        raise ProviderConfigurationError("GitHub kişisel erişim belirteci (PAT) yapılandırılmamış.")

    model_id = model if "/" in model else f"openai/{model}"

    def _build(model_id_final: str, url: str) -> Dict[str, Any]:
        return {
            "url": url,
            "payload": {
                "model": model_id_final,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens
            },
            "headers": {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/vnd.github+json"
            }
        }

    attempts = [_build(model_id_final=model_id, url=GITHUB_MODELS_URL_NEW)]
    if model_id != model:
        # Kullanıcı öneki siz vermişse yeni uçta zaten öneksiz Deneme gereksizdir; legacy ucunda öneki siz gerekir
        attempts.append(_build(model_id_final=model_id.split("/")[-1], url=GITHUB_MODELS_URL_LEGACY))
    else:
        attempts.append(_build(model_id_final=model_id, url=GITHUB_MODELS_URL_LEGACY))

    last_exc: Optional[ProviderError] = None
    for spec in attempts:
        for attempt in range(BACKOFF_MAX_RETRIES + 1):
            try:
                res = requests.post(
                    spec["url"], json=spec["payload"], headers=spec["headers"], timeout=REQUEST_TIMEOUT_SECS
                )
                if not res.ok:
                    err_exc = _classify_provider_http_error("GitHub Models", spec["payload"]["model"], res.status_code, res.text)
                    if err_exc.kind == "auth":
                        _disable_provider_temporarily("github")
                        raise err_exc
                    if err_exc.kind == "model_gone" and spec is attempts[0]:
                        # Yeni uç kendi tarafında model tanımayabilir → yedek ucu dene
                        last_exc = err_exc
                        break
                    last_exc = err_exc
                    if err_exc.kind == "transient" and attempt < BACKOFF_MAX_RETRIES:
                        _sleep_backoff(attempt)
                        continue
                    raise err_exc

                data = res.json()
                choices = data.get("choices", [])
                if not choices:
                    raise ProviderUnavailableError("GitHub Models boş seçim döndürdü.", provider="github", model=model)
                content = choices[0].get("message", {}).get("content", "").strip()
                if not content:
                    raise ProviderUnavailableError("GitHub Models boş metin döndürdü.", provider="github", model=model)
                return content

            except requests.exceptions.RequestException as exc:
                last_exc = ProviderUnavailableError(
                    f"GitHub Models bağlantı hatası: {exc}", provider="github", model=model
                )
                if attempt < BACKOFF_MAX_RETRIES:
                    _sleep_backoff(attempt)
                    continue
                break  # Sonraki uç/adım

    raise last_exc or ProviderUnavailableError("GitHub Models çağrısı tamamlanamadı.", provider="github", model=model)


def stream_github_models(
    messages: List[Dict[str, str]],
    model: str = GITHUB_MODEL_STANDARD,
    temperature: float = 0.65,
    max_tokens: int = 4096,
    custom_token: Optional[str] = None
) -> Generator[str, None, None]:
    """GitHub Models SSE akış (yeni uç nokta). Başarısızsa ProviderError fırlatır."""
    token = (custom_token or GITHUB_TOKEN).strip()
    if not token:
        raise ProviderConfigurationError("GitHub kişisel erişim belirteci (PAT) yapılandırılmamış.")

    model_id = model if "/" in model else f"openai/{model}"
    try:
        with requests.post(
            GITHUB_MODELS_URL_NEW,
            json={
                "model": model_id,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "stream": True
            },
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/vnd.github+json"
            },
            stream=True,
            timeout=STREAM_TIMEOUT_SECS
        ) as resp:
            if not resp.ok:
                exc = _classify_provider_http_error("GitHub Models", model_id, resp.status_code, resp.text[:300])
                if exc.kind == "auth":
                    _disable_provider_temporarily("github")
                raise exc

            for line in resp.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                    choices = chunk.get("choices", [])
                    if choices:
                        content = choices[0].get("delta", {}).get("content", "")
                        if content:
                            yield content
                except Exception:
                    continue
    except requests.exceptions.RequestException as exc:
        raise ProviderUnavailableError(f"GitHub Models akış bağlantısı koptu: {exc}", provider="github", model=model)


# ============================================================
# 4. AKILLI MODEL YÖNLENDİRİCİSİ (ROUTER & KASKAD)
# ============================================================

# Abonelik kademesi → öncelikli model kaskadı (DOĞRULANMIŞ GÜNCEL MODELLER)
TIER_CASCADES: Dict[str, List[Dict[str, str]]] = {
    "flagship": [
        {"provider": "gemini", "model": GEMINI_MODEL_FLAGSHIP},   # gemini-4-argon
        {"provider": "gemini", "model": GEMINI_MODEL_HIGH},       # gemini-3.8-flash
        {"provider": "groq", "model": GROQ_MODEL_FLAGSHIP},       # openai/gpt-oss-120b
        {"provider": "github", "model": GITHUB_MODEL_PRO},        # openai/gpt-4o
    ],
    "pro": [
        {"provider": "gemini", "model": GEMINI_MODEL_HIGH},       # gemini-3.8-flash
        {"provider": "gemini", "model": GEMINI_MODEL_PRO},        # gemini-3.6-flash
        {"provider": "groq", "model": GROQ_MODEL_FLAGSHIP},       # openai/gpt-oss-120b
        {"provider": "github", "model": GITHUB_MODEL_STANDARD},   # openai/gpt-4o-mini
    ],
    "standart": [
        {"provider": "gemini", "model": GEMINI_MODEL_PRO},        # gemini-3.6-flash
        {"provider": "groq", "model": GROQ_MODEL_FLAGSHIP},       # openai/gpt-oss-120b
        {"provider": "gemini", "model": GEMINI_MODEL_STANDARD},   # gemini-3.5-flash-lite
        {"provider": "groq", "model": GROQ_MODEL_STANDARD},       # openai/gpt-oss-20b
        {"provider": "github", "model": GITHUB_MODEL_STANDARD},   # openai/gpt-4o-mini
    ],
    "ekonomi": [
        {"provider": "groq", "model": GROQ_MODEL_STANDARD},       # openai/gpt-oss-20b
        {"provider": "gemini", "model": GEMINI_MODEL_STANDARD},   # gemini-3.5-flash-lite
        {"provider": "groq", "model": GROQ_MODEL_PREVIEW},        # qwen/qwen3.8-27b
        {"provider": "gemini", "model": GEMINI_MODEL_LITE},       # gemini-3.1-flash-lite
    ]
}

# Abonelik paket kimliği → model kademesi
SUBSCRIPTION_TIER_MAP: Dict[str, str] = {
    "premium_plus": "flagship",
    "premium": "flagship",
    "luks": "flagship",
    "pro_plus": "pro",
    "pro": "pro",
    "standart": "standart",
    "ekonomi": "ekonomi",
    "duo_ekonomi": "ekonomi",
    "aile_ekonomi": "ekonomi",
}

# Custom paket model_tier seçimi → model kademesi
CUSTOM_MODEL_TIER_MAP: Dict[str, str] = {
    "flagship": "flagship",
    "pro": "pro",
    "standard": "standart",
}


def resolve_model_tier(subscription_tier: str = "standart", custom_model_tier: Optional[str] = None) -> str:
    """Abonelik paketini model kademesine (flagship/pro/standart/ekonomi) dönüştürür."""
    tier = (subscription_tier or "standart").lower().strip()
    if tier == "custom" and custom_model_tier:
        return CUSTOM_MODEL_TIER_MAP.get(custom_model_tier.lower().strip(), "standart")
    return SUBSCRIPTION_TIER_MAP.get(tier, "standart")


def select_model_candidates(subscription_tier: str = "standart", custom_model_tier: Optional[str] = None) -> List[Dict[str, str]]:
    """Abonelik seviyesine göre öncelikli sağlayıcı ve model listesi üretir (güncel katalog)."""
    cascade_key = resolve_model_tier(subscription_tier, custom_model_tier)
    return list(TIER_CASCADES.get(cascade_key, TIER_CASCADES["standart"]))


def _credentials_exist(provider: str) -> bool:
    if provider == "gemini":
        return bool(GEMINI_API_KEY)
    if provider == "groq":
        return bool(GROQ_API_KEY)
    if provider == "github":
        return bool(GITHUB_TOKEN)
    return False


def _invoke_candidate(
    cand: Dict[str, str],
    messages: List[Dict[str, str]],
    temperature: float,
    max_tokens: int,
    keys: Dict[str, Optional[str]]
) -> str:
    """Tek model adayını çağırır; ProviderError taksonomisine göre hata fırlatır."""
    provider = cand["provider"]
    model = cand["model"]

    if provider == "gemini":
        return call_gemini(messages, model=model, temperature=temperature, max_tokens=max_tokens, custom_api_key=keys.get("gemini"))
    if provider == "groq":
        return call_groq(messages, model=model, temperature=temperature, max_tokens=max_tokens, custom_api_key=keys.get("groq"))
    if provider == "github":
        return call_github_models(messages, model=model, temperature=temperature, max_tokens=max_tokens, custom_token=keys.get("github"))
    raise ProviderConfigurationError(f"Bilinmeyen sağlayıcı arandı: {provider}")


def execute_chat_completion(
    messages: List[Dict[str, str]],
    subscription_tier: str = "standart",
    temperature: float = 0.65,
    max_tokens: int = 4096,
    custom_gemini_key: Optional[str] = None,
    custom_groq_key: Optional[str] = None,
    custom_github_token: Optional[str] = None,
    custom_model_tier: Optional[str] = None
) -> Tuple[str, str]:
    """
    Kaskad dayanıklılığıyla sohbet tamamlar.
    Dönen değer: (yanıt_metni, kullanılan_model_etiketi)

    Davranış (hata koduna göre):
      - 404 model bulunamadı → yeniden deneme YAPMA, sıradaki adaya geç
      - 429 → üstel bekleyip kısa süre tekrar dene, sonra sıradakine geç
      - 401/403 → yetki hatası; sağlayıcı bu süreçte 15 dk kaplanır, sıradakine geç
      - 5xx / ağ → üstel bekleyip tekrar dene, sonra sıradakine geç
    Hata sınıfları Türkçe anlaşılır mesajlar üretir (ProviderError taksonomisi).
    """
    keys = {"gemini": custom_gemini_key, "groq": custom_groq_key, "github": custom_github_token}

    # 1) Kullanıcı özel anahtar girdiyse önce özel anahtar önceliği verilir
    if custom_gemini_key and custom_gemini_key.strip():
        try:
            res = call_gemini(
                messages, model=GEMINI_MODEL_HIGH, temperature=temperature,
                max_tokens=max_tokens, custom_api_key=custom_gemini_key
            )
            return res, f"{GEMINI_MODEL_HIGH} (Özel Anahtar)"
        except ProviderError as exc:
            logger.warning(f"Özel Gemini anahtar denemesi başarısız (kaskada geçiliyor): {exc}")

    candidates = select_model_candidates(subscription_tier, custom_model_tier)
    last_error: Optional[ProviderError] = None
    configured_count = 0

    for cand in candidates:
        provider = cand["provider"]
        model = cand["model"]

        # Yapılandırılmamış sağlayıcıları erken ele (anahtar yoksa deneme bile yapma)
        has_custom = bool(keys.get(provider))
        if not has_custom and not _credentials_exist(provider):
            continue
        configured_count += 1

        # Yetki hatasıyla kapatılmış sağlayıcıyı bu turda atla (özel anahtarlı denemeler yine denenir)
        if not has_custom and _is_provider_auth_disabled(provider):
            logger.info(f"{provider} geçici olarak kapalı (son yetki hatası) — atlanıyor.")
            continue

        try:
            text = _invoke_candidate(cand, messages, temperature, max_tokens, keys)
            return text, f"{'Google' if provider == 'gemini' else provider.capitalize()} {model}"
        except ContentSafetyProviderError as exc:
            # İçerik filtreleri sağlayıcıya özgüdür — sıradaki modelle denenebilir
            last_error = exc
            logger.warning(f"İçerik filtresi ({provider}/{model}), kaskad sıradakine geçiyor: {exc}")
            continue
        except ProviderModelUnavailableError as exc:
            last_error = exc
            logger.warning(f"Model bulunamadı ({provider}/{model}) → kaskad sıradakine geçiyor: {exc}")
            continue
        except ProviderAuthError as exc:
            last_error = exc
            logger.warning(f"Yetki hatası ({provider}/{model}) → sıradakine geçiliyor: {exc}")
            continue
        except ProviderError as exc:
            last_error = exc
            logger.warning(f"{provider} ({model}) başarısız oldu, kaskad sıradakine geçiyor: {exc}")
            continue

    if configured_count == 0:
        raise ProviderConfigurationError(
            "Hiçbir yapay zeka sağlayıcı anahtarı yapılandırılmamış. "
            "Lütfen .env dosyasında GEMINI_API_KEY, GROQ_API_KEY veya GITHUB_TOKEN değerlerinden en az birini tanımlayın."
        )

    raise ProviderUnavailableError(
        f"Tüm yapay zeka model sağlayıcıları şu anda kullanılamıyor veya sonuç üretemedi. (Son hata: {last_error})"
    )


def stream_chat_completion(
    messages: List[Dict[str, str]],
    subscription_tier: str = "standart",
    temperature: float = 0.6,
    max_tokens: int = 4096,
    custom_gemini_key: Optional[str] = None,
    custom_groq_key: Optional[str] = None,
    custom_github_token: Optional[str] = None,
    custom_model_tier: Optional[str] = None
) -> Tuple[Generator[str, None, None], str]:
    """
    Kaskad destekli canlı akış. İlk başarılı sağlayıcı akışı devralır.
    Dönen değer: (metin_parçaları_jeneratörü, kullanılan_model_etiketi)
    """
    keys = {"gemini": custom_gemini_key, "groq": custom_groq_key, "github": custom_github_token}
    candidates = select_model_candidates(subscription_tier, custom_model_tier)
    last_error: Optional[ProviderError] = None

    for cand in candidates:
        provider = cand["provider"]
        model = cand["model"]

        if not keys.get(provider) and not _credentials_exist(provider):
            continue

        try:
            if provider == "gemini":
                gen = stream_gemini(messages, model=model, temperature=temperature, max_tokens=max_tokens, custom_api_key=keys.get("gemini"))
            elif provider == "groq":
                gen = stream_groq(messages, model=model, temperature=temperature, max_tokens=max_tokens, custom_api_key=keys.get("groq"))
            else:
                gen = stream_github_models(messages, model=model, temperature=temperature, max_tokens=max_tokens, custom_token=keys.get("github"))

            label = f"{'Google' if provider == 'gemini' else provider.capitalize()} {model}"
            return gen, label
        except ProviderError as exc:
            last_error = exc
            logger.warning(f"Canlı akış adayı başarısız ({provider}/{model}) → sıradakine geçiliyor: {exc}")
            continue

    if last_error:
        raise last_error
    raise ProviderConfigurationError(
        "Canlı akış için yapılandırılmış sağlayıcı bulunamadı. Lütfen .env dosyasındaki API anahtarlarını kontrol edin."
    )


# ============================================================
# SAĞLIK TANILAMA BİLGİSİ (opsiyonel)
# ============================================================

def list_configured_providers() -> Dict[str, bool]:
    """Hangi sağlayıcıların anahtarının mevcut olduğunu döner (health endpoint için)."""
    return {
        "gemini": bool(GEMINI_API_KEY),
        "groq": bool(GROQ_API_KEY),
        "github": bool(GITHUB_TOKEN)
    }
