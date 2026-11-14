# Lumina AI — Konum Zekâsı Sistemi Üretim Hazırlığı Denetim Raporu

**Tarih:** 13 Kasım 2026
**Kapsam:** Konum, Harita, Yerler (Places New), Rota, Hava Durumu, izin yönetimi, güvenlik, test kapsamı ve maliyet
**Karar:** **NO-GO** (üretime çıkış için koşullar sağlanmadı)
**Hazırlayan:** Otomatik kod denetimi + canlı doğrulama (yalnızca anahtarsız sağlayıcılarda)

---

## 1. Yönetici Özeti

Konum zekâsı sistemi **mimari olarak sağlam ve savunmacı** yazılmış: sağlayıcı verisi gelmezse sahte veri üretmiyor, sunucu anahtarı istemciye sızmıyor, izin durum makinesi hem sohbet hem HTTP endpoint yolunda aynı kuralları uyguluyor. Mock/otomatik testlerin tamamı geçiyor.

Ancak **üretime çıkış için yeterli değil**, çünkü:

1. **Gerçek Google Maps Platform anahtarı ve faturalandırma yok.** Places (New), Routes ve Geocoding canlı olarak hiç çalıştırılmadı. Bu, projenin en kritik ve en pahalı üç entegrasyonu.
2. **`GOOGLE_MAPS_JS_API_KEY` yok.** Google Haritalar tarayıcı yolu canlı doğrulanmadı; yalnızca OSM/Leaflet yedek kod yolu var.
3. **Canlı hava testleri kısmen geçti** (Open-Meteo 3 test). OpenWeatherMap yedeği ve ticari Open-Meteo aboneliği doğrulanmadı.
4. **Kota sayaçları süreç içi bellekte.** Çoklu worker/instance ortamında gerçek limitler çarpılır; maliyet koruması garanti değil.
5. **Kimlik doğrulama varsayılanları üretim için güvensiz.** `LUMINA_ALLOW_LOCAL_AUTH` varsayılanı `1`, `LUMINA_DISABLE_LOCAL_ORIGINS` varsayılanı `0`.
6. **Gerçek tarayıcı, gerçek Android cihaz, gerçek geolocation izin akışı ve uçtan uca HTTPS akışı test edilmedi.**

**Sonuç:** Kod kalitesi pilot/demo için yeterli; **üretim için NO-GO.** Aşağıdaki "GO Koşulları" tamamlandığında yeniden değerlendirilebilir.

---

## 2. Yöntem ve Değişiklik Öncesi Yedek

- Denetim öncesi doğrulanmış yedek alındı: `_BACKUP_AUDIT_20261113_093649`
  - **57 dosya** + `SHA256_MANIFEST.txt` (58 girdi).
- Yedek klasörü silinmedi ve değiştirilmedi.
- Denetim sırasında çalışan mimari yeniden yazılmadı; yalnızca tespit edilen somut hatalar düzeltildi.
- Hiçbir API anahtarı, servis hesabı bilgisi veya özel yapılandırma değeri rapora/dosyaya yazılmadı.
- Hiçbir canlı test "geçti" sayılmadı; çalıştırılmayan testler açıkça `BLOCKED_BY_EXTERNAL_CONFIGURATION` olarak işaretlendi.

---

## 3. Mimari Genel Bakış

| Modül | Sorumluluk |
|---|---|
| `location_service.py` | Koordinat doğrulama, TTL önbellek, kota/devre kesici, geocoding, `request_json` |
| `location_permission_service.py` | İzin durum makinesi (`unset/granted/denied/manual/off`), istek origin çözümü, yuvarlama |
| `places_service.py` | Google Places (New) Nearby/Text, alan maskesi, normalizasyon, sıralama |
| `routes_service.py` | Google Routes API, polyline, adım sınırı, 500 km sınırı, yuvarlama |
| `weather_service.py` | Open-Meteo birincil, OpenWeatherMap yedek, saat dilimi, günlük/saatlik, bayat önbellek |
| `maps_service.py` | Harita sağlayıcı seçimi (Google JS / OSM), public config |
| `location_intelligence.py` | Türkçe niyet tespiti, orkestrasyon, Smart UI blokları |
| `smart_ui.py` | Şemalar, `SERVER_ONLY_UI_TYPES`, blok doğrulama |
| `location_ui.js` | İzin modalı, harita, hava/rota/mekân kartları |
| `app.js` | Sohbet konum payload'ı, Smart UI sanitizasyonu |

**Temel tasarım ilkesi:** Canlı konum/hava/rota blokları **yalnızca sunucuda** üretilir. Model çıktısındaki aynı tipler istemcide ve sunucuda reddedilir (`SERVER_ONLY_UI_TYPES`). Bu, modelin uydurma konum verisi enjekte etmesini engeller.

---

## 4. Öncelik 1 — Places (New), Routes, Geocoding, Maps JavaScript

### 4.1 Places API (New)

- **Doğru uç nokta ve yöntem:** Nearby araması `POST https://places.googleapis.com/v1/places:searchNearby`; Text araması ayrı uç nokta. `X-Goog-FieldMask` zorunlu ve gönderiliyor.
- **Alan maskesi** şunları içeriyor: `id, displayName, formattedAddress, location, rating, userRatingCount, priceLevel, types, primaryTypeDisplayName, googleMapsUri, websiteUri, nationalPhoneNumber, businessStatus`.
- **SKU etkisi:** `rating`/`userRatingCount` (Pro) + `priceLevel`/`websiteUri`/`nationalPhoneNumber` (Enterprise) alanları nedeniyle istek **Enterprise SKU**'ya düşer. Bu, listelenen "Pro" fiyatından daha pahalıdır. Atmosfer alanları (yorum/fotoğraf) eklenirse **Enterprise+Atmosphere** olur.
- **Yanıt doğrulama:** Koordinatlar `validate_coordinates` ile doğrulanır; isim boşsa atlanır; puan `0–5` dışındaysa `None`; yorum sayısı negatifse `None`; bilinmeyen fiyat seviyesi güvenli biçimde yok sayılır.
- **Boş sonuç:** Sahte işletme üretilmez; kullanıcıya dürüst "sonuç yok" mesajı döner.
- **Sıralama:** `nearest`, `top_rated`, `recommended` **ayrı ayrı** hesaplanır ve gerekçe metni (`ranking_explanation`) üretilir. "En yakın" ile "en yüksek puanlı" birbirine karıştırılmaz.
- **Düzeltme:** Puansız işletmelerin, çok düşük puanlı işletmelerin üstüne çıkabildiği `recommended` sıralama hatası kapatıldı. Artık puansızlar koşulsuz olarak puanlıların altında.

### 4.2 Routes API

- `POST https://routes.googleapis.com/directions/v2:computeRoutes`, alan maskesi mevcut.
- Mesafe, süre, polyline ve navigasyon adımları dönüyor; adımlar **30** ile sınırlı, polyline **6000** karakterle sınırlı.
- **500 km** üzeri doğrudan mesafe reddediliyor (maliyet ve kötüye kullanım koruması).
- `TRAFFIC_AWARE` yalnızca sürüş modunda.
- Rota koordinatları **4 ondalık** (~11 m) ile yuvarlanıyor.

### 4.3 Geocoding

- Google Geocoding birincil; anahtar yoksa/başarısızsa **Open-Meteo geocoding** yedeği (env ile kapatılabilir).
- Sorgu temizleme (`sanitize_place_query`) kontrol karakterlerini engelliyor; çok kısa sorgu reddediliyor.
- 24 saatlik önbellek.

### 4.4 Maps JavaScript

- Sunucu anahtarı (`GOOGLE_MAPS_API_KEY`) istemciye **asla** verilmiyor.
- Yalnızca `GOOGLE_MAPS_JS_API_KEY` (HTTP referrer + Maps JavaScript API ile kısıtlı olması gereken) `/api/v1/location/config` üzerinden, kimliği doğrulanmış istemciye veriliyor.
- JS anahtarı yoksa harita **OSM + Leaflet** yedeğine düşüyor ve bunu dürüstçe bildiriyor.
- Test, `public_map_config()` çıktısında sunucu anahtarının bulunmadığını doğruluyor.

### 4.5 Faturalandırma / kota / hata yönetimi

- Sağlayıcı bazlı günlük üst sınırlar (`ProviderQuotaGuard`): Places 2000, Geocoding 2000, Routes 1000, Open-Meteo 8000, OpenWeather 500.
- Kullanıcı bazlı limitler: dakikada 12, kullanıcı/gün 60, misafir/gün 10.
- Devre kesici ve zaman aşımı (2–20 sn) mevcut.
- Sağlayıcı hata mesajları koordinat içermiyor; Türkçe ve sır sızdırmıyor.

### 4.6 Öncelik 1 — Canlı doğrulama durumu

> **CANLI TEST EDİLMEDİ.** Gerçek `GOOGLE_MAPS_API_KEY` ve faturalandırma olmadığı için Places (New), Routes ve Geocoding gerçek sağlayıcıya karşı çalıştırılamadı. Bu testler "geçti" sayılmaz.

---

## 5. Öncelik 2 — Hava Durumu (Open-Meteo / OpenWeatherMap)

- **Birincil:** Open-Meteo. **Anahtarsız çalışacak şekilde doğru yapılandırılmış** (`open_meteo_configured: True`). Anahtar zorunlu tutulmuyor.
- **Yedek:** OpenWeatherMap. `OPENWEATHER_API_KEY` yoksa devre dışı; varsa Open-Meteo hatasında devreye giriyor ve `fallback_from` / `warning` alanlarıyla bunu bildiriyor.
- **Saat dilimi:** Open-Meteo `utc_offset_seconds` ve IANA `timezone` dönüyor. Günlük seçim yerel tarihe göre.
- **Yarın / öbür gün / bugün:** `select_target_day` hedef günü seçiyor; saatlik veriler artık **hedef güne göre filtreleniyor**. Önceden "yarın" başlığı altında bugünün saatleri görünebiliyordu; düzeltildi. Hedef gün için saatlik veri yoksa **boş liste** dönüyor (yanlış gün gösterilmiyor).
- **Yağış olasılığı:** `precipitation_probability` hem saatlik hem günlük seviyede mevcut.
- **Eksik veri:** Sağlayıcı yoksa/başarısızsa tahmin **uydurulmuyor**; açık hata dönüyor.
- **Önbellek:** TTL 600 sn, bayat pencere 6 saat. Bayat veri `stale=True`, `live=False` ile işaretleniyor; "canlı" gibi sunulmuyor.
- **Düzeltme:** OpenWeatherMap'in UTC `dt_txt` değerleri yerel saate çevriliyor; günlük bucket'lar yerel tarihe göre.
- **Sınırlar:** OpenWeather yedeği 3 saatlik adımlar döndürür (gerçek saatlik değil), timezone etiketi IANA adı değil `UTC+3` biçiminde olabilir ve 5 günlük tahmin sınırı vardır. Bunlar kullanıcıya yansıtılmalı.
- **Ticari kullanım:** Open-Meteo **ücretsiz katman ticari kullanıma uygun değildir** (10.000/gün, 5.000/saat, 600/dakika, CC BY 4.0 atıf). Ticari kullanım için `customer-api.open-meteo.com` + `OPEN_METEO_API_KEY` ve abonelik gerekir.

### 5.1 Öncelik 2 — Canlı doğrulama (gerçekten geçen)

`LUMINA_RUN_LIVE_LOCATION_TESTS=1` ile:

- **GEÇTİ:** Open-Meteo hava durumu
- **GEÇTİ:** Open-Meteo geocoding fallback
- **GEÇTİ:** Harita sağlayıcı durumu (dürüst raporlama)

Canlı Open-Meteo çıktısı (13 Kasım 2026):

```
source          = Open-Meteo
timezone        = Europe/Istanbul
utc_offset      = 10800
fetched_at      = 2026-11-13T06:49:32Z
stale           = False   live = True
daily_dates     = 2026-11-13, 2026-11-14, 2026-11-15
tomorrow_date   = 2026-11-14
tomorrow_pop    = 100.0 %
hourly_count    = 48
hourly_range    = 2026-11-13T10:00 → 2026-11-15T09:00
```

**ATLANDI (geçti sayılmaz):** Google Places Nearby, Google Routes — `GOOGLE_MAPS_API_KEY` yok.
**CANLI TEST EDİLMEDİ:** OpenWeatherMap yedeği (`OPENWEATHER_API_KEY` yok), ticari Open-Meteo aboneliği.

---

## 6. Öncelik 3 — Güvenlik, Gizlilik, CORS, Anahtar Maruziyeti

### 6.1 Tarayıcı geolocation ve izin akışı

- İzin durumları: `unset`, `granted`, `denied`, `manual`, `off`.
- İzin reddi/kapatma kalıcı olarak hatırlanır; tekrar sorulmaz.
- `navigator.permissions.query` ile tarayıcı izni okunur; `getCurrentPosition` zaman aşımı ve hata mesajları Türkçe.
- Manuel şehir seçimi her zaman mümkün; konum zorunlu değil.

### 6.2 Backend istek doğrulama (düzeltme yapıldı)

- Cihaz koordinatı **açık rıza** (`consent=true`) gerektiriyor.
- **Kritik düzeltme:** Daha önce kaydedilmiş `denied`/`off` durumu, endpoint yolunda `consent=true` ile ezilebiliyordu. Artık **reddedilen/kapatılan konum cihaz koordinatını her koşulda reddediyor.** Sohbet yolu ile endpoint yolu aynı kuralı uyguluyor.
- Şehir adı verilirse cihaz koordinatı yerine geocoding sonucu kullanılıyor.

### 6.3 Koordinat hassasiyeti

| Kullanım | Ondalık | Yaklaşık hassasiyet |
|---|---|---|
| Places / Geocoding / Hava | 3 | ~110 m |
| Rota | 4 | ~11 m |
| Manuel şehir | 2 | ~1.1 km |
| Cihaz koordinatı (sunucuda) | 4 | ~11 m |

- Cihaz koordinatı **yalnızca istek için** kullanılıyor, **kalıcı olarak saklanmıyor**.
- Eski sürümlerin saklamış olabileceği yüksek hassasiyetli koordinatlar `normalize_preference` tarafından düşürülüyor.

### 6.4 Kullanıcı izolasyonu

- Konum tercihi `uid` bazlı profil kaydında tutuluyor.
- Misafir kullanıcılar imzalı `guest_*` kimliğiyle ayrılıyor.
- Bir kullanıcının koordinatı başka kullanıcının isteğine karışmıyor.

### 6.5 Anahtar maruziyeti

- Sunucu anahtarı (`GOOGLE_MAPS_API_KEY`) istemci kodunda **yok**; yalnızca backend kullanıyor.
- `app.js` ve `config.js` içindeki `AIza…` değerleri **Firebase web API anahtarı**dır, Maps sunucu anahtarı değildir.
- Maps JS anahtarı yalnızca kimliği doğrulanmış `/api/v1/location/config` yanıtında dönüyor ve kısıtlı olması gerekiyor.
- `google-services.json` / `firabase.json` Firebase API anahtarı içeriyor; `.gitignore`'a eklendi (daha önce ekli değildi).

### 6.6 CORS ve başlıklar

- İzinli origin listesi: **tam olarak** `https://arelozcan3545-max.github.io` + geliştirme origin'leri.
- **Wildcard + credentials birleşmesi yok.**
- `allow_credentials=True` yalnızca açık liste ile.
- `LUMINA_DISABLE_LOCAL_ORIGINS=1` ile yerel origin'ler üretimde kapatılabilir (varsayılan `0` — üretimde açılmalı).
- Güvenlik başlıkları: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
- **Düzeltme:** `Permissions-Policy` `geolocation=()` → `geolocation=(self)`. Böylece backend aynı origin'den frontend servis ederse tarayıcı konum API'si sessizce kırılmaz; üçüncü taraf çerçeveler yine engellenir.

### 6.7 Loglama ve hassas veri

- Loglarda koordinat yok.
- Sağlayıcı URL'leri (anahtar içerebilir) loglanmıyor.
- Hata mesajları koordinatsız ve Türkçe.
- Cihaz koordinatı kalıcı saklanmıyor.

### 6.8 Öncelik 3 — Açık riskler

| Risk | Durum | Etki |
|---|---|---|
| `LUMINA_ALLOW_LOCAL_AUTH` varsayılanı `1` | Açık | Üretimde `Bearer local` → `local_user` kimlik doğrulaması atlatılabilir |
| `LUMINA_DISABLE_LOCAL_ORIGINS` varsayılanı `0` | Açık | Yerel origin'ler üretimde açık kalır |
| `LUMINA_GUEST_SECRET` tanımsızsa geçici anahtar | Orta | Süreç yeniden başlayınca misafir token'ları geçersizleşir |
| CSRF token yok | Kabul edilebilir | Bearer + sıkı CORS; çerez oturumuna geçilirse gerekli |
| CSP başlığı yok | Açık | CDN bağımlılıkları nedeniyle ertelenmiş |
| Üretim HTTPS backend URL'si yok | Açık | Uçtan uca akış canlı doğrulanamıyor |

---

## 7. Öncelik 4 — Test Kategorileri ve Gerçek Sonuçlar

Test kategorileri **ayrı ayrı** raporlanır. Atlanan/çalıştırılmayan test hiçbir koşulda "geçti" sayılmaz.

### 7.1 Kategori tablosu

| Kategori | Durum | Sonuç |
|---|---|---|
| Otomatik birim + mock entegrasyon (Python) | **Çalıştırıldı** | **212 passed, 5 skipped, 0 failed** |
| Konum servis/orkestrasyon (Python) | **Çalıştırıldı** | **60 passed** |
| İstemci (Node) | **Çalıştırıldı** | **21 passed, 0 failed** |
| Canlı API (anahtarsız) | **Kısmen çalıştırıldı** | **3 passed, 2 skipped** |
| Canlı Google API | **Çalıştırılmadı** | 2 test `BLOCKED_BY_EXTERNAL_CONFIGURATION` |
| Gerçek tarayıcı (Playwright/axe) | **Çalıştırılmadı** | Altyapı yok |
| Gerçek Android cihaz | **Çalıştırılmadı** | Cihaz/emülatör yok |
| Gerçek geolocation izin akışı | **Çalıştırılmadı** | Tarayıcı/cihaz gerekli |

### 7.2 Ne kapsanıyor

- İzin reddi/iptali, manuel şehir, `unset + consent` kabulü
- Endpoint yolunda `denied`/`off` reddi
- Cihaz koordinatının 4 ondalığa yuvarlanması
- Google → Open-Meteo geocoding fallback
- Places sıralama garantisi (puansız < puanlı), boş sonuç
- Hava stale cache işaretleme, hedef gün saatlik filtresi, hedef gün verisi yokken boş liste
- OpenWeather UTC → yerel saat dönüşümü
- Rota 500 km sınırı, polyline, adım sınırı
- Sunucu anahtarı sızıntısı testi
- Kota/timeout/devre kesici
- Server-only Smart UI tiplerinin model çıktısında reddi

### 7.3 Ne kapsanmıyor (dürüst beyan)

- Gerçek Google yanıtlarının şema uyumu (alan adları, SKU, hata kodları)
- Gerçek Google faturalandırma/kota davranışı
- Gerçek Maps JavaScript yüklemesi ve harita çizimi
- Gerçek OpenWeather yedeği
- Gerçek Firebase/Firestore oturumu
- Gerçek OAuth (Google ile giriş)
- Gerçek üretim HTTPS backend ile uçtan uca akış
- Fiziksel cihazda ses çıktısı ve mobil düzen
- Erişilebilirlik (axe) ve görsel regresyon

### 7.4 Doğrulama komutları ve çıktılar

```powershell
# Python regresyon
$env:PYTHONIOENCODING='utf-8'; & '.venv\Scripts\python.exe' -m pytest tests -q
# → 212 passed, 5 skipped, 1 warning in ~2.8s

# Yalnızca konum servis/orkestrasyon
& '.venv\Scripts\python.exe' -m pytest tests/test_location_services.py -q
# → 60 passed

# İstemci
& 'C:\Program Files\nodejs\node.exe' --test tests-js
# → tests 21, pass 21, fail 0

# Sözdizimi
& 'C:\Program Files\nodejs\node.exe' --check app.js
& 'C:\Program Files\nodejs\node.exe' --check location_ui.js

# Canlı (anahtarsız)
$env:LUMINA_RUN_LIVE_LOCATION_TESTS='1'
& '.venv\Scripts\python.exe' -m pytest tests/test_location_live.py -q -rs
# → 3 passed, 2 skipped
#   SKIPPED: GOOGLE_MAPS_API_KEY yok (Places Nearby)
#   SKIPPED: GOOGLE_MAPS_API_KEY yok (Routes)
```

Not: Tam paketteki 5 skip, canlı test kapısı kapalı olduğu için atlanan 5 canlı testtir. Canlı kapı açıldığında bunlardan 3'ü geçer, 2'si Google anahtarı olmadığı için atlanır.

---

## 8. Öncelik 5 — Mevcut Özelliklerle Entegrasyon / Regresyon

Konum entegrasyonunun mevcut sistemi bozmadığı **212 geçen Python testi + 21 Node testi** ile doğrulandı.

| Alan | Durum | Kanıt |
|---|---|---|
| Sohbet akışı | Bozulmadı | `test_api.py`, `test_personality_modes.py` geçti |
| Kimlik doğrulama | Bozulmadı | `test_api.py`, `test_cors_production.py` geçti |
| Smart UI | Bozulmadı | `test_smart_ui.py` geçti; server-only tipler korunuyor |
| Streaming | Bozulmadı | Sunucu blokları `allowServerOnly` ile geçiyor, model çıktısı filtreleniyor |
| Sohbet geçmişi | Bozulmadı | Regresyon testleri geçti |
| Abonelik limitleri | Bozulmadı | Kota testleri geçti |
| Ses motoru | Bozulmadı | 10 Node ses testi geçti |
| AI sağlayıcıları | Bozulmadı | `test_models_provider.py`, `test_api_allocation.py` geçti |
| Mobil uyumluluk | **Canlı doğrulanmadı** | Gerçek cihaz/tarayıcı testi yok |

**Kritik güvenlik davranışı:** Modelin ürettiği `location_results`, `weather_forecast`, `route_info`, `location_request`, `location_info` blokları istemcide ve sunucuda reddediliyor; yalnızca sunucunun gerçek sağlayıcı verisinden ürettiği bloklar gösteriliyor.

---

## 9. Öncelik 6 — Üretim Engelleri, Riskler, Maliyet ve Yapılandırma

### 9.1 Üretim engelleri (blocker)

1. Gerçek `GOOGLE_MAPS_API_KEY` + faturalandırma + API etkinleştirmesi yok → Places/Routes/Geocoding canlı doğrulanamıyor.
2. `GOOGLE_MAPS_JS_API_KEY` yok → Google harita yolu canlı doğrulanamıyor.
3. Kota sayaçları süreç içi bellekte → çoklu worker/instance'ta limitler çarpılır, restart'ta sıfırlanır.
4. `LUMINA_ALLOW_LOCAL_AUTH=1` ve `LUMINA_DISABLE_LOCAL_ORIGINS=0` üretim için güvensiz varsayılanlar.
5. Gerçek üretim HTTPS backend URL'si yok → uçtan uca akış doğrulanamıyor.
6. Gerçek tarayıcı/Android geolocation izin akışı test edilmedi.
7. `serviceAccountKey.json` yok → Firebase Admin/Firestore canlı çalışmıyor (`firebase: local_fallback`).
8. Web Firebase `appId` yok; `config.js` yalnızca Android `appId` içeriyor → gerçek web OAuth testi yapılamıyor.
9. Open-Meteo ticari aboneliği yok → ticari kullanım koşulu karşılanmıyor.
10. Git deposu yok → sürüm kontrolü, commit, geri alma yok.

### 9.2 Güvenlik riskleri (öncelik sırasına göre)

| # | Risk | Önem | Öneri |
|---|---|---|---|
| 1 | `Bearer local` üretimde açık | **Yüksek** | `LUMINA_ALLOW_LOCAL_AUTH=0` |
| 2 | Yerel origin'ler üretimde açık | **Yüksek** | `LUMINA_DISABLE_LOCAL_ORIGINS=1` |
| 3 | Süreç içi kota sayacı | **Yüksek** | Redis/DB tabanlı paylaşımlı sayaç |
| 4 | Maps JS anahtarı kısıtlanmamışsa kötüye kullanım | **Yüksek** | HTTP referrer + yalnızca Maps JS API kısıtı |
| 5 | `LUMINA_GUEST_SECRET` yoksa geçici anahtar | Orta | Sabit, güçlü, 32+ karakter secret |
| 6 | Firebase API anahtarı `google-services.json` içinde | Orta | `.gitignore` eklendi; anahtar kısıtları uygulanmalı |
| 7 | CSP yok | Orta | Nonce/hash tabanlı CSP planı |
| 8 | HTTPS zorunluluğu belgelenmemiş | Orta | Yalnızca HTTPS; HSTS |
| 9 | Gerçek cihaz testi yok | Orta | Playwright + Android smoke test |

### 9.3 Eksik kimlik bilgileri / dış yapılandırma

- `GOOGLE_MAPS_API_KEY` (sunucu; Places New + Routes + Geocoding etkin)
- `GOOGLE_MAPS_JS_API_KEY` (tarayıcı; referrer kısıtlı)
- `GOOGLE_MAPS_MAP_ID` (opsiyonel)
- `OPENWEATHER_API_KEY` (yedek hava)
- `OPEN_METEO_API_KEY` + ticari abonelik (ticari kullanım)
- `serviceAccountKey.json` (Firebase Admin)
- Web Firebase `appId` (gerçek web yapılandırması)
- `LUMINA_GUEST_SECRET` (güçlü)
- `LUMINA_ADMIN_TOKEN` (yönetici uç noktası)
- Üretim HTTPS backend URL'si
- Google Cloud faturalandırma hesabı ve API etkinleştirmeleri
- Firebase Console: yetkili alan adları + Google sağlayıcısı

### 9.4 Tahmini API maliyetleri

> Aşağıdakiler **resmî liste fiyatlarına dayalı tahmindir**, teklif değildir. Fiyatlar 13 Kasım 2026 itibarıyla doğrulanmıştır. Gerçek maliyet kullanım dağılımına, SKU'ya ve ücretsiz kotalara göre değişir.

**Birim fiyatlar (1.000 istek başına, USD):**

| Servis | SKU | Fiyat | Aylık ücretsiz kota |
|---|---|---|---|
| Places (New) Nearby/Text | Pro | $32 | 5.000 |
| Places (New) Nearby/Text | Enterprise | $35 | 1.000 |
| Places (New) Nearby/Text | Enterprise+Atmosphere | $40 | 1.000 |
| Routes — Compute Routes | Essentials | $5 | 10.000 |
| Routes — Compute Routes | Pro | $10 | 5.000 |
| Geocoding | — | $5 | 10.000 |
| Maps JavaScript — Dynamic Maps | — | $7 | 10.000 |
| Open-Meteo | Standard (1M çağrı) | ~$29/ay | — |
| Open-Meteo | Professional (5M çağrı) | ~$99/ay | — |

**Mevcut alan maskesi Enterprise SKU'ya düşer.** Yani Places maliyeti $35/1.000 üzerinden hesaplanmalıdır.

** Senaryo tabloları (varsayımsal dağılım):**

| Senaryo | MAU | Kişi başı aylık konum işlemi | Toplam | Tahmini aylık maliyet |
|---|---|---|---|---|
| Pilot | 1.000 | 10 | 10.000 | **~$140–$169** |
| Büyüme | 10.000 | 15 | 150.000 | **~$3.060** |
| Ölçek | 50.000 | 20 | 1.000.000 | **~$21.500** |

**Pilot detay (10.000 işlem; %50 Places, %25 hava, %15 rota, %10 geocoding):**

- Places: 5.000 → 4.000 billable × $0.035 = **$140**
- Geocoding: 1.000 → ücretsiz kota içinde = **$0**
- Routes: 1.500 → ücretsiz kota içinde = **$0**
- Open-Meteo: 2.500 → ticari değilse **$0**, ticariyse **$29**
- Maps JS: ~3.000 yükleme → ücretsiz kota içinde = **$0**

**Büyüme detay (150.000 işlem):**

- Places: 75.000 → 74.000 × $0.035 = **$2.590**
- Geocoding: 15.000 → 5.000 × $0.005 = **$25**
- Routes: 22.500 → 17.500 × $0.010 = **$175**
- Open-Meteo: 37.500 → Standard **$29**
- Maps JS: 45.000 → 35.000 × $0.007 = **$245**
- **Toplam ≈ $3.064**

**Ölçek detay (1.000.000 işlem):**

- Places: 500.000 → 499.000 × $0.035 = **$17.465**
- Geocoding: 100.000 → 90.000 × $0.005 = **$450**
- Routes: 150.000 → 145.000 × $0.010 = **$1.450**
- Open-Meteo: 250.000 → Professional **$99**
- Maps JS: 300.000 → 290.000 × $0.007 = **$2.030**
- **Toplam ≈ $21.494**

**Maliyet kontrol önerileri:**

- Alan maskesini küçültmek SKU'yu düşürebilir; ancak `priceLevel`/`websiteUri`/`nationalPhoneNumber` kaldırılırsa ürün özellikleri azalır. Karar ürünle birlikte verilmeli.
- Önbellek TTL'lerini (Places 300 sn, hava 600 sn, rota 120 sn, geocoding 24 saat) korumak tekrar çağrıları ciddi biçimde azaltır.
- Kullanıcı/gün ve sağlayıcı/gün limitleri maliyet tavanı sağlar; **ancak paylaşımlı depoya taşınmalıdır.**
- `LUMINA_ENABLE_LOCATION=0` ile özellik tamamen kapatılabilir (acil fren).

### 9.5 Gerekli manuel yapılandırma kontrol listesi

- [ ] `LUMINA_ALLOW_LOCAL_AUTH=0`
- [ ] `LUMINA_DISABLE_LOCAL_ORIGINS=1`
- [ ] Güçlü `LUMINA_GUEST_SECRET` (32+ karakter, rastgele)
- [ ] Güçlü `LUMINA_ADMIN_TOKEN`
- [ ] `ALLOWED_ORIGINS=https://arelozcan3545-max.github.io` (yalnızca üretim)
- [ ] Google Cloud: faturalandırma + Geocoding/Places (New)/Routes/Maps JS etkin
- [ ] Sunucu anahtarı: IP kısıtı (mümkünse) ve yalnızca gerekli API'ler
- [ ] Tarayıcı anahtarı: HTTP referrer + yalnızca Maps JavaScript API
- [ ] Firebase Console: yetkili alan adları + Google sağlayıcısı + web `appId`
- [ ] `serviceAccountKey.json` güvenli biçimde sunucuya yerleştirildi (repoya değil)
- [ ] Open-Meteo ticari abonelik + `OPEN_METEO_API_KEY`
- [ ] `OPENWEATHER_API_KEY` (yedek için)
- [ ] Paylaşımlı kota deposu (Redis/DB)
- [ ] HTTPS backend + HSTS
- [ ] `google-services.json` / `firabase.json` repoya eklenmiyor (`.gitignore` doğrulandı)

### 9.6 GO koşulları (NO-GO → GO)

Aşağıdakilerin **tamamı** sağlanmadan GO verilmemeli:

1. Gerçek Google anahtarıyla Places Nearby/Text, Routes, Geocoding canlı testleri geçti.
2. Kısıtlı `GOOGLE_MAPS_JS_API_KEY` ile harita gerçek tarayıcıda yüklendi.
3. Gerçek tarayıcıda geolocation izin akışı (izin/ret/iptal) doğrulandı.
4. En az bir gerçek Android cihazda mobil smoke test geçti.
5. Gerçek HTTPS üretim backend'i ile uçtan uca sohbet + konum akışı doğrulandı.
6. Paylaşımlı kota deposu devrede; çoklu worker senaryosu test edildi.
7. Üretim güvenlik env'leri uygulandı (`LUMINA_ALLOW_LOCAL_AUTH=0`, `LUMINA_DISABLE_LOCAL_ORIGINS=1`, güçlü secret).
8. Firebase Admin + web OAuth gerçek hesapla doğrulandı.
9. Ticari hava sağlayıcısı sözleşmesi/anahtarı hazır.
10. Maliyet tavanı ve bütçe alarmı Google Cloud'da tanımlı.

---

## 10. Denetim Kapsamında Yapılan Düzeltmeler

| Dosya | Düzeltme |
|---|---|
| `main.py` | Endpoint yolunda `denied`/`off` durumu artık `consent=true` ile ezilemiyor; cihaz koordinatı 4 ondalığa yuvarlanıyor |
| `main.py` | `Permissions-Policy`: `geolocation=()` → `geolocation=(self)` |
| `location_permission_service.py` | Sohbet yolunda cihaz koordinatı 4 ondalığa yuvarlanıyor |
| `places_service.py` | `recommended` sıralamada puansızların puanlıların üstüne çıkması kesin olarak engellendi |
| `location_intelligence.py` | `_hourly_for_scope` eklendi; "yarın/öbür gün/bugün" kartlarında saatlik veri hedef güne göre filtreleniyor |
| `weather_service.py` | Saatlik pencere 48 saate çıkarıldı; OpenWeather `dt_txt` UTC → yerel saat; günlük bucket'lar yerel tarihe göre |
| `.gitignore` | `google-services.json`, `firabase.json`, `firebase.json` eklendi |
| `tests/test_location_services.py` | 9 yeni test: endpoint izin reddi, `off` reddi, `unset + consent`, 4 ondalık yuvarlama, sıralama garantisi, hedef gün filtresi, boş saatlik, OpenWeather UTC→yerel |
| `docs/TESTING.md` | 212 toplam, 60 konum testi, canlı 3 passed/2 skipped |
| `docs/SECURITY.md` | `geolocation=(self)` ve gerekçesi |
| `FINAL_RAPOR.md` | "Gerçek Konum Zekâsı" ek raporu |

**Toplam test artışı:** 52 → **60** konum testi; 204 → **212** toplam Python testi.

---

## 11. Değişen Dosyalar (son doğrulama)

```
app.js                          (istemci konum payload + sanitizasyon)
location_ui.js                  (izin modalı, harita, kartlar)
FINAL_RAPOR.md                  (ek rapor)
places_service.py               (sıralama düzeltmesi + alan maskesi)
location_intelligence.py        (hedef gün saatlik filtresi)
.gitignore                      (Firebase istemci dosyaları)
location_permission_service.py  (koordinat yuvarlama)
main.py                         (endpoint izin zorlaması, güvenlik başlığı)
weather_service.py              (48 saat, UTC→yerel)
docs/TESTING.md
docs/SECURITY.md
tests/test_location_services.py
```

---

## 12. Limit Sayacı Konusu (ayrı ve açık)

Kullanıcının daha önce bildirdiği **"çoğu cihazda kullanamıyo diye limit sayacı çalışmıyo"** sorunu bu konum denetiminden **bağımsızdır**.

**Kullanıcı netleştirmesi (13 Kasım 2026):** Sorun **günlük mesaj/görsel kotası** sayacı ile ilgilidir (abonelik planı sayacı). Ses profilleri ve API havuzu limiti bu kapsamda değildir.

Bu konu denetim kapsamında **kod değişikliği yapılmadan** açık bırakılmıştır. Doğru teşhis için hâlâ şunlar gereklidir:

- Sayacın göründüğü ekranın **ekran görüntüsü**, veya
- Sayacın/uyarının **tam metni**, veya
- Hangi planda (ücretsiz/ücretli), hangi işlemde (mesaj mı, görsel mi) ve sayaç sıfırlanınca mı yoksa hiç artmayınca mı sorun çıktığı.

Bu bilgi olmadan "düzeltildi" demek uydurma olur. Bu konu ayrı bir teşhis oturumunda ele alınmalıdır; konum denetiminin GO/NO-GO kararını etkilemez.

---

## 13. Sonuç

| Boyut | Değerlendirme |
|---|---|
| Mimari | ✅ Sağlam, modüler, savunmacı |
| Sahte veri üretmeme | ✅ Model ve sunucu tarafında korumalı |
| Anahtar güvenliği | ✅ Sunucu anahtarı istemcide yok; JS anahtarı kısıtlı |
| İzin/gizlilik | ✅ Red/off kalıcı, koordinat yuvarlanıyor, cihaz koordinatı saklanmıyor |
| Otomatik testler | ✅ 212 + 21 geçti |
| Canlı sağlayıcı doğrulaması | ⚠️ Yalnızca Open-Meteo (3 test) |
| Google entegrasyonu | ❌ Canlı doğrulanmadı |
| Tarayıcı/cihaz testi | ❌ Yapılmadı |
| Kota/maliyet koruması | ⚠️ Süreç içi; paylaşımlı depo gerekli |
| Üretim yapılandırması | ❌ Güvensiz varsayılanlar |

### Karar: **NO-GO**

Kod pilot ve iç demo için hazır. Üretim için **9.6 GO koşulları** tamamlanmalı ve özellikle **gerçek Google anahtarıyla canlı testler** ile **gerçek tarayıcı/cihaz doğrulaması** yapılmalıdır. Bunlar tamamlanmadan "canlı test edildi" veya "üretime hazır" denmemelidir.

---

*Bu rapor, 13 Kasım 2026 tarihli denetim oturumunun kanıtlarına dayanır. Fiyatlar resmî liste fiyatlarıdır ve teklif niteliği taşımaz. Hiçbir API anahtarı veya gizli değer bu belgeye yazılmamıştır.*
