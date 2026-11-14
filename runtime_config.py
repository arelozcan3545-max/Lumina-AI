# ============================================================
# LUMINA AI - RUNTIME / PRODUCTION CONFIGURATION
# ============================================================
# Bu modül:
#   - Çalışma ortamını (production / development) algılar.
#   - Üretim için güvenli varsayılanları uygular.
#   - Eksik/geçersiz zorunlu üretim yapılandırmasında net hata üretir.
#   - Yapılandırma denetimini SIR DEĞERİ yazmadan raporlar.
#
# Kural: Bu modül hiçbir zaman ortam değişkeninin DEĞERİNİ loglamaz,
#        API yanıtına koymaz veya rapora yazmaz. Yalnızca "var/yok",
#        "geçerli/geçersiz" ve uzunluk gibi sızdırmayan bilgiler döner.
# ============================================================

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

from deployment_config import PRODUCTION_ORIGIN

ENVIRONMENT_VARIABLE = "LUMINA_ENV"
PRODUCTION_VALUES = frozenset({"production", "prod"})
DEVELOPMENT_VALUES = frozenset({"development", "dev", "local", "test", "testing"})

# Barındırma platformlarının üretim göstergeleri. Açık LUMINA_ENV her zaman
# bu göstergelerden önce gelir.
PRODUCTION_MARKERS = (
    "RENDER",
    "FLY_APP_NAME",
    "K_SERVICE",            # Google Cloud Run
    "WEBSITE_SITE_NAME",    # Azure App Service
    "WEBSITE_INSTANCE_ID",
    "DYNO",                 # Heroku
    "RAILWAY_ENVIRONMENT",
    "VERCEL",
)

TRUTHY = frozenset({"1", "true", "yes", "on"})
FALSY = frozenset({"0", "false", "no", "off"})

MIN_GUEST_SECRET_LENGTH = 32


class ProductionConfigError(RuntimeError):
    """Üretim için zorunlu yapılandırma eksik/geçersiz olduğunda fırlatılır."""


class InvalidConfigurationError(ValueError):
    """Bir ortam değişkeni okunamıyor/geçersiz formatta olduğunda fırlatılır."""


@dataclass
class StartupValidation:
    """Başlangıç doğrulamasının sır içermeyen sonucu."""

    environment: str
    production: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    audit: List[Dict[str, str]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _source(env: Optional[Mapping[str, str]]) -> Mapping[str, str]:
    return env if env is not None else os.environ


def _read(env: Optional[Mapping[str, str]], name: str) -> str:
    return str(_source(env).get(name, "") or "").strip()


def detect_environment(env: Optional[Mapping[str, str]] = None) -> str:
    """Çalışma ortamını döner.

    Öncelik sırası:
      1. LUMINA_ENV (açık ve yetkili)
      2. ENVIRONMENT / APP_ENV (diğer yaygın adlar)
      3. Bilinen barındırma platformu işaretleri -> production
      4. development
    """
    explicit = _read(env, ENVIRONMENT_VARIABLE) or _read(env, "ENVIRONMENT") or _read(env, "APP_ENV")
    if explicit:
        return explicit.lower()
    source = _source(env)
    for marker in PRODUCTION_MARKERS:
        if _read(env, marker):
            return "production"
    return "development"


def is_production(env: Optional[Mapping[str, str]] = None) -> bool:
    return detect_environment(env) in PRODUCTION_VALUES


def _flag(
    env: Optional[Mapping[str, str]],
    name: str,
    *,
    default: bool,
) -> bool:
    """Boolean ortam değişkeni okur; boşsa varsayılanı döner."""
    raw = _read(env, name).lower()
    if not raw:
        return default
    if raw in TRUTHY:
        return True
    if raw in FALSY:
        return False
    raise InvalidConfigurationError(
        f"{name} geçersiz değer içeriyor. Beklenen: 1/0, true/false, yes/no, on/off."
    )


def allow_local_auth(env: Optional[Mapping[str, str]] = None) -> bool:
    """Geliştirme-only `Bearer local` yolunun açık olup olmadığı.

    Üretimde varsayılan KAPALI'dır. Üretimde açıkça 1 yapılırsa başlangıç
    doğrulaması hata verir; bu fonksiyon yine de False döner.
    """
    if is_production(env):
        return False
    return _flag(env, "LUMINA_ALLOW_LOCAL_AUTH", default=True)


def allow_local_auth_explicitly_enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    """`LUMINA_ALLOW_LOCAL_AUTH` üretimde açıkça açılmış mı?"""
    raw = _read(env, "LUMINA_ALLOW_LOCAL_AUTH").lower()
    return bool(raw) and raw in TRUTHY


def disable_local_origins(env: Optional[Mapping[str, str]] = None) -> bool:
    """Yerel CORS origin'lerinin kapatılıp kapatılmayacağı.

    Üretimde varsayılan AÇIK (yerel origin'ler kapalı). Geliştirmede
    varsayılan KAPALI (yerel origin'ler açık).
    """
    return _flag(env, "LUMINA_DISABLE_LOCAL_ORIGINS", default=is_production(env))


def allow_unsigned_guest(env: Optional[Mapping[str, str]] = None) -> bool:
    """İmzasız `guest_*` kimliklerine izin verilsin mi? Varsayılan: hayır."""
    return _flag(env, "LUMINA_ALLOW_UNSIGNED_GUEST", default=False)


def guest_secret(env: Optional[Mapping[str, str]] = None) -> str:
    """Misafir HMAC sırrını döner (yoksa boş). Değer asla loglanmaz."""
    return _read(env, "LUMINA_GUEST_SECRET")


def guest_secret_is_strong(env: Optional[Mapping[str, str]] = None) -> bool:
    return len(guest_secret(env)) >= MIN_GUEST_SECRET_LENGTH


def admin_token_present(env: Optional[Mapping[str, str]] = None) -> bool:
    return bool(_read(env, "LUMINA_ADMIN_TOKEN"))


def _is_local_origin(origin: str) -> bool:
    lowered = (origin or "").lower()
    return (
        "localhost" in lowered
        or "127.0.0.1" in lowered
        or "[::1]" in lowered
        or "0.0.0.0" in lowered
    )


def _audit_item(name: str, category: str, status: str, detail: str) -> Dict[str, str]:
    return {
        "name": name,
        "category": category,
        "status": status,
        "detail": detail,
    }


def configuration_audit(
    *,
    env: Optional[Mapping[str, str]] = None,
    firebase_admin_ready: Optional[bool] = None,
    firestore_ready: Optional[bool] = None,
    firebase_token_verification_available: Optional[bool] = None,
    allowed_origins: Optional[List[str]] = None,
    quota_backend: Optional[str] = None,
) -> List[Dict[str, str]]:
    """Sır değeri içermeyen yapılandırma denetimi döner.

    Kategoriler:
      - required: üretimde zorunlu
      - optional: opsiyonel
      - development_only: yalnızca geliştirme
      - production_only: yalnızca üretimde anlamlı
    Durumlar: ok / missing / invalid / optional / disabled
    """
    production = is_production(env)
    source = _source(env)
    items: List[Dict[str, str]] = []

    env_name = detect_environment(env)
    known_env = env_name in PRODUCTION_VALUES | DEVELOPMENT_VALUES
    items.append(_audit_item(
        ENVIRONMENT_VARIABLE,
        "required",
        "ok" if known_env else "invalid",
        f"Algılanan ortam: {env_name}" if known_env else f"Bilinmeyen ortam: {env_name}",
    ))

    secret = guest_secret(env)
    if not secret:
        items.append(_audit_item(
            "LUMINA_GUEST_SECRET",
            "required" if production else "development_only",
            "missing" if production else "optional",
            "Üretimde zorunlu; tanımlı değil." if production else "Tanımlı değil (geliştirme geçici sır üretir).",
        ))
    elif len(secret) < MIN_GUEST_SECRET_LENGTH:
        items.append(_audit_item(
            "LUMINA_GUEST_SECRET",
            "required",
            "invalid",
            f"Çok kısa (<{MIN_GUEST_SECRET_LENGTH} karakter).",
        ))
    else:
        items.append(_audit_item(
            "LUMINA_GUEST_SECRET",
            "required",
            "ok",
            "Tanımlı ve yeterli uzunlukta.",
        ))

    if allow_local_auth_explicitly_enabled(env):
        items.append(_audit_item(
            "LUMINA_ALLOW_LOCAL_AUTH",
            "development_only",
            "invalid" if production else "ok",
            "Üretimde AÇIK; güvenlik ihlali." if production else "Geliştirme için açık.",
        ))
    else:
        items.append(_audit_item(
            "LUMINA_ALLOW_LOCAL_AUTH",
            "development_only",
            "disabled",
            "Kapalı (üretim için doğru)." if production else "Kapalı.",
        ))

    try:
        local_origins_disabled = disable_local_origins(env)
        disable_status = "ok"
        disable_detail = (
            "Yerel origin'ler kapalı." if local_origins_disabled else "Yerel origin'ler açık."
        )
        if production and not local_origins_disabled:
            disable_status = "invalid"
            disable_detail = "Üretimde yerel origin'ler açık; güvenlik ihlali."
    except InvalidConfigurationError:
        disable_status = "invalid"
        disable_detail = "Geçersiz boolean değeri."

    items.append(_audit_item(
        "LUMINA_DISABLE_LOCAL_ORIGINS",
        "development_only",
        disable_status,
        disable_detail,
    ))

    try:
        unsigned_guest = allow_unsigned_guest(env)
    except InvalidConfigurationError:
        items.append(_audit_item(
            "LUMINA_ALLOW_UNSIGNED_GUEST", "development_only", "invalid", "Geçersiz boolean değeri."
        ))
    else:
        items.append(_audit_item(
            "LUMINA_ALLOW_UNSIGNED_GUEST",
            "development_only",
            "invalid" if (production and unsigned_guest) else "ok",
            "Üretimde AÇIK; güvenlik ihlali." if (production and unsigned_guest) else "Kapalı.",
        ))

    items.append(_audit_item(
        "LUMINA_ADMIN_TOKEN",
        "optional",
        "ok" if admin_token_present(env) else "optional",
        "Tanımlı (yönetici uç noktası açık)." if admin_token_present(env) else "Tanımlı değil; yönetici uç noktası kapalı.",
    ))

    if firebase_admin_ready is None:
        items.append(_audit_item(
            "FIREBASE_ADMIN",
            "required" if production else "optional",
            "missing" if production else "optional",
            "Durum bilinmiyor." if production else "Opsiyonel; yerel mod kullanılabilir.",
        ))
    else:
        items.append(_audit_item(
            "FIREBASE_ADMIN",
            "required" if production else "optional",
            "ok" if firebase_admin_ready else ("missing" if production else "optional"),
            "Hazır." if firebase_admin_ready else ("Üretimde zorunlu; hazır değil." if production else "Kapalı; yerel mod."),
        ))

    if firestore_ready is None:
        items.append(_audit_item(
            "FIRESTORE",
            "required" if production else "optional",
            "missing" if production else "optional",
            "Durum bilinmiyor." if production else "Opsiyonel; yerel mod kullanılabilir.",
        ))
    else:
        items.append(_audit_item(
            "FIRESTORE",
            "required" if production else "optional",
            "ok" if firestore_ready else ("missing" if production else "optional"),
            "Hazır." if firestore_ready else ("Üretimde zorunlu; hazır değil." if production else "Kapalı; yerel mod."),
        ))

    if firebase_token_verification_available is None:
        items.append(_audit_item(
            "FIREBASE_TOKEN_VERIFICATION",
            "required",
            "missing" if production else "optional",
            "Durum bilinmiyor." if production else "Opsiyonel.",
        ))
    else:
        items.append(_audit_item(
            "FIREBASE_TOKEN_VERIFICATION",
            "required",
            "ok" if firebase_token_verification_available else ("missing" if production else "optional"),
            "Hazır (Admin SDK veya google-auth)." if firebase_token_verification_available else "Kullanılabilir doğrulama yolu yok.",
        ))

    origins = list(allowed_origins or [])
    local_in_allowlist = [o for o in origins if _is_local_origin(o)]
    wildcard = "*" in origins
    origin_issues = []
    if wildcard:
        origin_issues.append("wildcard")
    if production and local_in_allowlist:
        origin_issues.append(f"{len(local_in_allowlist)} yerel origin")
    non_https = [o for o in origins if not str(o).lower().startswith("https://")]
    if production and non_https:
        origin_issues.append(f"{len(non_https)} HTTPS olmayan origin")
    if production and origins and PRODUCTION_ORIGIN not in origins:
        origin_issues.append("üretim origin'i listede yok")
    items.append(_audit_item(
        "ALLOWED_ORIGINS",
        "required" if production else "optional",
        "invalid" if origin_issues else "ok",
        ", ".join(origin_issues) if origin_issues else f"{len(origins)} origin (wildcard yok).",
    ))

    items.append(_audit_item(
        "QUOTA_BACKEND",
        "required" if production else "optional",
        "ok" if (quota_backend == "firestore" or not production) else "invalid",
        (
            "Firestore (paylaşımlı/atomik)." if quota_backend == "firestore"
            else ("Üretimde Firestore zorunlu; mevcut: " + str(quota_backend))
        ),
    ))

    # Opsiyonel / geliştirme-only değişkenler (değer içermez).
    for name, category, label in (
        ("GEMINI_API_KEY", "optional", "Sağlayıcı anahtarı"),
        ("GROQ_API_KEY", "optional", "Sağlayıcı anahtarı"),
        ("GITHUB_TOKEN", "optional", "Sağlayıcı anahtarı"),
        ("GOOGLE_MAPS_API_KEY", "optional", "Konum sağlayıcısı"),
        ("GOOGLE_TTS_API_KEY", "optional", "TTS sağlayıcısı"),
        ("AZURE_SPEECH_KEY", "optional", "TTS sağlayıcısı"),
        ("TAVILY_API_KEY", "optional", "Web araması"),
        ("BRAVE_SEARCH_API_KEY", "optional", "Web araması yedeği"),
        ("SERPER_API_KEY", "optional", "Web araması yedeği"),
        ("LUMINA_OSM_USER_AGENT", "optional", "OpenStreetMap istemci kimliği"),
    ):
        items.append(_audit_item(
            name,
            category,
            "ok" if _read(env, name) else "optional",
            f"{label} tanımlı." if _read(env, name) else f"{label} tanımlı değil.",
        ))

    items.append(_audit_item(
        "LUMINA_ENABLE_PAID_PROVIDERS",
        "optional",
        "ok" if _read(env, "LUMINA_ENABLE_PAID_PROVIDERS") not in ("", "0") else "disabled",
        "Ücretli sağlayıcılar açık." if _read(env, "LUMINA_ENABLE_PAID_PROVIDERS") not in ("", "0") else "Ücretli sağlayıcılar kapalı.",
    ))

    return items


def validate_startup_configuration(
    *,
    env: Optional[Mapping[str, str]] = None,
    firebase_admin_ready: Optional[bool] = None,
    firestore_ready: Optional[bool] = None,
    firebase_token_verification_available: Optional[bool] = None,
    allowed_origins: Optional[List[str]] = None,
    quota_backend: Optional[str] = None,
) -> StartupValidation:
    """Başlangıçta çağrılır. Üretimde güvenli olmayan yapılandırmayı reddeder.

    Geliştirmede hata üretmez; yalnızca uyarı toplar. Üretimde zorunlu
    yapılandırma eksik/geçersizse `errors` doldurulur ve çağıran taraf
    `ProductionConfigError` fırlatmalıdır.
    """
    environment = detect_environment(env)
    production = environment in PRODUCTION_VALUES
    known_environment = environment in PRODUCTION_VALUES | DEVELOPMENT_VALUES

    errors: List[str] = []
    warnings: List[str] = []

    if not known_environment:
        errors.append(
            f"{ENVIRONMENT_VARIABLE} bilinmeyen bir ortam bildiriyor: '{environment}'. "
            "Beklenen: production/prod veya development/dev/local/test."
        )

    if production:
        if allow_local_auth_explicitly_enabled(env):
            errors.append(
                "Üretimde LUMINA_ALLOW_LOCAL_AUTH=1 kullanılamaz. "
                "Yerel `Bearer local` kimlik doğrulaması üretimde devre dışı olmalıdır."
            )

        try:
            local_origins_disabled = disable_local_origins(env)
        except InvalidConfigurationError as exc:
            errors.append(str(exc))
            local_origins_disabled = True
        if not local_origins_disabled:
            errors.append(
                "Üretimde LUMINA_DISABLE_LOCAL_ORIGINS=0 kullanılamaz. "
                "Yerel geliştirme origin'leri kapatılmalıdır."
            )

        try:
            unsigned_guest_allowed = allow_unsigned_guest(env)
        except InvalidConfigurationError as exc:
            errors.append(str(exc))
            unsigned_guest_allowed = False
        if unsigned_guest_allowed:
            errors.append(
                "Üretimde LUMINA_ALLOW_UNSIGNED_GUEST=1 kullanılamaz. "
                "İmzasız misafir kimlikleri kabul edilmemelidir."
            )

        if not guest_secret(env):
            errors.append(
                "Üretimde LUMINA_GUEST_SECRET zorunludur. "
                "En az 32 karakterlik rastgele bir değer tanımlayın."
            )
        elif not guest_secret_is_strong(env):
            errors.append(
                f"Üretimde LUMINA_GUEST_SECRET en az {MIN_GUEST_SECRET_LENGTH} karakter olmalıdır."
            )

        if firebase_admin_ready is False:
            errors.append(
                "Üretimde Firebase Admin SDK ve servis hesabı zorunludur. "
                "serviceAccountKey.json bulunamadı veya başlatılamadı."
            )
        if firestore_ready is False:
            errors.append(
                "Üretimde Firestore bağlantısı zorunludur. "
                "Kota sayaçları kalıcı ve atomik olmalıdır."
            )
        if firebase_token_verification_available is False:
            errors.append(
                "Üretimde Firebase ID token doğrulaması için Admin SDK veya google-auth gereklidir."
            )
        if quota_backend is not None and quota_backend != "firestore":
            errors.append(
                "Üretimde kota arka ucu 'firestore' olmalıdır; "
                f"mevcut: '{quota_backend}'. Yerel JSON'a sessiz düşüşe izin verilmez."
            )

        origins = list(allowed_origins or [])
        if not origins:
            errors.append("Üretimde ALLOWED_ORIGINS boş olamaz.")
        else:
            if "*" in origins:
                errors.append("Üretimde CORS wildcard ('*') kullanılamaz.")
            local_origins = [o for o in origins if _is_local_origin(o)]
            if local_origins:
                errors.append(
                    "Üretimde yerel CORS origin'leri bulunamaz: "
                    + ", ".join(local_origins)
                )
            non_https = [o for o in origins if not str(o).lower().startswith("https://")]
            if non_https:
                errors.append(
                    "Üretimde tüm CORS origin'leri HTTPS olmalıdır: "
                    + ", ".join(non_https)
                )
            if PRODUCTION_ORIGIN and PRODUCTION_ORIGIN not in origins:
                errors.append(
                    f"Üretim origin'i ({PRODUCTION_ORIGIN}) ALLOWED_ORIGINS içinde bulunamadı."
                )

        if not admin_token_present(env):
            warnings.append(
                "LUMINA_ADMIN_TOKEN tanımlı değil; yönetici uç noktası (/api/v1/keys/pool) kapalı olacak."
            )
    else:
        if not guest_secret(env):
            warnings.append(
                "LUMINA_GUEST_SECRET tanımlı değil; geliştirme için geçici sır üretildi. "
                "Üretimde zorunludur."
            )
        if firebase_admin_ready is False:
            warnings.append("Firebase Admin kapalı; yerel geliştirme modu kullanılıyor.")
        if firestore_ready is False:
            warnings.append("Firestore kapalı; kota sayaçları yerel JSON üzerinde tutulacak.")

    audit = configuration_audit(
        env=env,
        firebase_admin_ready=firebase_admin_ready,
        firestore_ready=firestore_ready,
        firebase_token_verification_available=firebase_token_verification_available,
        allowed_origins=allowed_origins,
        quota_backend=quota_backend,
    )

    return StartupValidation(
        environment=environment,
        production=production,
        errors=errors,
        warnings=warnings,
        audit=audit,
    )


def raise_for_startup_validation(result: StartupValidation) -> None:
    """Doğrulama hatalarını tek, net bir başlangıç hatasına dönüştürür."""
    if result.ok:
        return
    message = (
        "Lumina AI üretim yapılandırması geçersiz; sunucu başlatılmadı. "
        "Düzeltilmesi gereken noktalar:\n- "
        + "\n- ".join(result.errors)
    )
    raise ProductionConfigError(message)


def public_environment_summary(
    *,
    env: Optional[Mapping[str, str]] = None,
    firebase_admin_ready: Optional[bool] = None,
    firestore_ready: Optional[bool] = None,
    firebase_token_verification_available: Optional[bool] = None,
    allowed_origins: Optional[List[str]] = None,
    quota_backend: Optional[str] = None,
) -> Dict[str, Any]:
    """Health endpoint için sır içermeyen özet."""
    result = validate_startup_configuration(
        env=env,
        firebase_admin_ready=firebase_admin_ready,
        firestore_ready=firestore_ready,
        firebase_token_verification_available=firebase_token_verification_available,
        allowed_origins=allowed_origins,
        quota_backend=quota_backend,
    )
    return {
        "environment": result.environment,
        "production": result.production,
        "configuration_ok": result.ok,
        "configuration_errors": list(result.errors),
        "configuration_warnings": list(result.warnings),
        "checks": result.audit,
    }
