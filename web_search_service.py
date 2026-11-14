# ============================================================
# LUMINA AI - LIVE WEB SEARCH SERVICE
# ------------------------------------------------------------
# Purpose-built, API-based web search for the assistant pipeline.
#
# Rules:
#   * A provider must be explicitly configured through an API key.
#   * An HTTP 202, an empty body or a timeout is NEVER reported as a
#     successful search. Those are surfaced as a clear status so the
#     assistant can say "live search is temporarily unavailable".
#   * Only http(s) URLs are accepted. javascript:/data: links are
#     dropped, so the model never receives an unsafe citation.
#   * Published date and retrieved date are kept separate.
#   * Results expire from cache quickly; stale snippets are not served
#     as if they were fresh.
# ============================================================

from __future__ import annotations

from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from location_service import LocationServiceError, TTLCache, cache_ttl, request_json, utc_now_iso

# Provider order: the first configured provider wins.
PROVIDER_ENV_KEYS = (
    ("tavily", "TAVILY_API_KEY"),
    ("brave", "BRAVE_SEARCH_API_KEY"),
    ("serper", "SERPER_API_KEY"),
)

PROVIDER_LABELS = {
    "tavily": "Tavily Search API",
    "brave": "Brave Search API",
    "serper": "Serper (Google Search) API",
}

DEFAULT_MAX_RESULTS = 5

_web_cache = TTLCache(cache_ttl("web_search", 300), max_entries=128)


def _env_key(name: str) -> str:
    import os

    return (os.getenv(name) or "").strip()


def configured_provider() -> Optional[str]:
    """Returns the first configured provider id, or None."""
    for provider, env_key in PROVIDER_ENV_KEYS:
        if _env_key(env_key):
            return provider
    return None


def web_search_configured() -> bool:
    return configured_provider() is not None


def _safe_http_url(value: Any) -> Optional[str]:
    """Accepts only absolute http(s) URLs with a host."""
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw or len(raw) > 800:
        return None
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"}:
        return None
    if not parsed.netloc or "." not in parsed.netloc:
        return None
    return raw


def _clean_text(value: Any, limit: int) -> Optional[str]:
    if value is None:
        return None
    text = " ".join(str(value).split()).strip()
    return text[:limit] if text else None


def _result(
    *,
    title: Any,
    url: Any,
    snippet: Any,
    published_at: Any,
    retrieved_at: str,
) -> Optional[Dict[str, Any]]:
    safe_url = _safe_http_url(url)
    if not safe_url:
        return None
    safe_title = _clean_text(title, 200) or safe_url
    return {
        "title": safe_title,
        "url": safe_url,
        "domain": (urlparse(safe_url).netloc or "")[:120] or None,
        "snippet": _clean_text(snippet, 500),
        "published_at": _clean_text(published_at, 40),
        "retrieved_at": retrieved_at,
    }


def _search_tavily(query: str, max_results: int) -> Dict[str, Any]:
    key = _env_key("TAVILY_API_KEY")
    payload = request_json(
        "POST",
        "https://api.tavily.com/search",
        provider="tavily",
        timeout=10,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
            "include_answer": False,
            "topic": "general",
        },
    )
    retrieved_at = utc_now_iso()
    results: List[Dict[str, Any]] = []
    for item in list(payload.get("results") or []):
        if not isinstance(item, dict):
            continue
        normalized = _result(
            title=item.get("title"),
            url=item.get("url"),
            snippet=item.get("content"),
            published_at=item.get("published_date"),
            retrieved_at=retrieved_at,
        )
        if normalized:
            results.append(normalized)
    return {"results": results, "retrieved_at": retrieved_at}


def _search_brave(query: str, max_results: int) -> Dict[str, Any]:
    key = _env_key("BRAVE_SEARCH_API_KEY")
    payload = request_json(
        "GET",
        "https://api.search.brave.com/res/v1/web/search",
        provider="brave_search",
        timeout=10,
        headers={"X-Subscription-Token": key, "Accept": "application/json"},
        params={
            "q": query,
            "count": max_results,
            "search_lang": "tr",
            "country": "tr",
            "text_decorations": "false",
            "safesearch": "moderate",
        },
    )
    retrieved_at = utc_now_iso()
    web = payload.get("web") or {}
    results: List[Dict[str, Any]] = []
    for item in list(web.get("results") or []):
        if not isinstance(item, dict):
            continue
        normalized = _result(
            title=item.get("title"),
            url=item.get("url"),
            snippet=item.get("description"),
            published_at=item.get("page_age") or item.get("age"),
            retrieved_at=retrieved_at,
        )
        if normalized:
            results.append(normalized)
    return {"results": results, "retrieved_at": retrieved_at}


def _search_serper(query: str, max_results: int) -> Dict[str, Any]:
    key = _env_key("SERPER_API_KEY")
    payload = request_json(
        "POST",
        "https://google.serper.dev/search",
        provider="serper",
        timeout=10,
        headers={"X-API-KEY": key, "Content-Type": "application/json"},
        json={"q": query, "num": max_results, "gl": "tr", "hl": "tr"},
    )
    retrieved_at = utc_now_iso()
    results: List[Dict[str, Any]] = []
    for item in list(payload.get("organic") or []):
        if not isinstance(item, dict):
            continue
        normalized = _result(
            title=item.get("title"),
            url=item.get("link"),
            snippet=item.get("snippet"),
            published_at=item.get("date"),
            retrieved_at=retrieved_at,
        )
        if normalized:
            results.append(normalized)
    return {"results": results, "retrieved_at": retrieved_at}


_SEARCHERS = {
    "tavily": _search_tavily,
    "brave": _search_brave,
    "serper": _search_serper,
}


def _status_payload(status: str, message: Optional[str], *, provider: Optional[str] = None) -> Dict[str, Any]:
    return {
        "available": status == "ok",
        "status": status,
        "provider": provider,
        "provider_label": PROVIDER_LABELS.get(provider or "", None),
        "results": [],
        "fetched_at": utc_now_iso(),
        "message": message,
    }


def search_web(query: str, *, max_results: int = DEFAULT_MAX_RESULTS) -> Dict[str, Any]:
    """Runs one live search. Never raises; failures are explicit statuses."""
    q = " ".join((query or "").split()).strip()
    if len(q) < 2:
        return _status_payload("invalid_query", "Arama sorgusu çok kısa.", provider=configured_provider())
    max_results = max(1, min(10, int(max_results or DEFAULT_MAX_RESULTS)))

    provider = configured_provider()
    if not provider:
        return _status_payload(
            "not_configured",
            "Canlı web arama sağlayıcısı yapılandırılmadı. Sunucuda TAVILY_API_KEY, "
            "BRAVE_SEARCH_API_KEY veya SERPER_API_KEY tanımlanmalı. Canlı arama şu anda "
            "geçici olarak kullanılamıyor.",
            provider=None,
        )

    cache_key = f"web:{provider}:{max_results}:{q.casefold()}"
    cached = _web_cache.get(cache_key)
    if cached:
        value = dict(cached[0])
        value["cached"] = True
        value["cache_age_seconds"] = cached[1]
        return value

    try:
        payload = _SEARCHERS[provider](q, max_results)
    except LocationServiceError as exc:
        code = getattr(exc, "code", "")
        if code in {"provider_quota_exceeded"} or getattr(exc, "status_code", None) == 429:
            status = "rate_limited"
            message = f"{PROVIDER_LABELS[provider]} kotası doldu. Canlı arama şu anda kullanılamıyor."
        elif code in {"provider_not_configured"} or getattr(exc, "status_code", None) in (401, 403):
            status = "invalid_credentials"
            message = (
                f"{PROVIDER_LABELS[provider]} kimlik bilgisi geçersiz veya yetkisiz. "
                "Canlı arama şu anda kullanılamıyor."
            )
        elif code == "provider_timeout":
            status = "timeout"
            message = f"{PROVIDER_LABELS[provider]} zamanında yanıt vermedi. Canlı arama şu anda kullanılamıyor."
        else:
            status = "upstream_error"
            message = f"{PROVIDER_LABELS[provider]} isteği tamamlanamadı. Canlı arama şu anda kullanılamıyor."
        return _status_payload(status, message, provider=provider)
    except Exception:  # pragma: no cover - defensive
        return _status_payload(
            "upstream_error",
            "Canlı arama sırasında beklenmeyen bir hata oluştu.",
            provider=provider,
        )

    results = list(payload.get("results") or [])[:max_results]
    fetched_at = payload.get("retrieved_at") or utc_now_iso()
    status = "ok" if results else "empty"
    message = None if results else "Arama yapıldı ancak eşleşen sonuç bulunamadı."
    result = {
        "available": bool(results),
        "status": status,
        "provider": provider,
        "provider_label": PROVIDER_LABELS.get(provider),
        "results": results,
        "fetched_at": fetched_at,
        "message": message,
        "cached": False,
        "cache_age_seconds": 0,
    }
    # Empty responses are cached briefly too, so a provider outage does not
    # trigger a request storm, but they are never served as "ok".
    _web_cache.set(cache_key, result)
    return result


def format_web_context(result: Optional[Dict[str, Any]]) -> Optional[str]:
    """Formats real search results for the model. Returns None when unusable."""
    if not result or result.get("status") != "ok":
        return None
    results = list(result.get("results") or [])
    if not results:
        return None
    provider_label = result.get("provider_label") or result.get("provider") or "bilinmiyor"
    lines = [
        f"CANLI WEB ARAMA SONUÇLARI (sağlayıcı: {provider_label}, alınma: {result.get('fetched_at')}):",
    ]
    for index, item in enumerate(results, start=1):
        published = item.get("published_at") or "yayın tarihi belirtilmemiş"
        lines.append(
            f"{index}. [{item.get('title')}]({item.get('url')}) — "
            f"yayın: {published} · alınma: {item.get('retrieved_at')}"
        )
        if item.get("snippet"):
            lines.append(f"   {item.get('snippet')}")
    lines.append(
        "Kaynakları yanıtında tıklanabilir bağlantı olarak göster. Yayın tarihi ile alınma "
        "tarihini karıştırma. Listede olmayan kaynak, başlık veya URL UYDURMA. Bu sonuçlar "
        "arama anındaki hâli yansıtır; daha yeni bir gelişme olmuş olabilir."
    )
    return "\n".join(lines)


def web_search_unavailable_note(result: Optional[Dict[str, Any]]) -> Optional[str]:
    """Builds an honest limitation note when live search did not run."""
    if not result:
        return None
    status = result.get("status")
    if status == "ok":
        return None
    message = result.get("message") or "Canlı web araması şu anda kullanılamıyor."
    return (
        "📡 CANLI WEB ARAMA DURUMU: "
        f"{message} Arama yapılmış gibi davranma, kaynak veya bağlantı UYDURMA. "
        "Kullanıcı güncel bilgi istiyorsa canlı aramanın geçici olarak kullanılamadığını "
        "açıkça söyle; elindeki güvenilir genel bilgiyle yetin ve bunu belirt."
    )


def web_search_status() -> Dict[str, Any]:
    return {
        "configured": web_search_configured(),
        "provider": configured_provider(),
        "providers": [{"id": pid, "label": PROVIDER_LABELS[pid]} for pid, _ in PROVIDER_ENV_KEYS],
        "cache_entries": len(_web_cache),
    }
