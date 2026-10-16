# 🔍 LUMINA AI — TEKNİK DENETİM RAPORU (FAZ 1: KEŞİF)

> **Denetim Tarihi:** 16 Ekim 2026
> **Denetlenen Proje:** Lumina AI (`E:\LuminaStudios Software Company\Lumina AI`)
> **Proje Sahibi / Kurucu:** Arel — LuminaStudios
> **Geri Dönüş Noktası (Yedek):** `E:\LuminaStudios Software Company\Lumina AI_BACKUP_20261016_1213`

---

## 1. YÖNETİCİ ÖZETİ

Lumina AI, FastAPI tabanlı profesyonel bir yapay zeka platformudur. Backend mimarisi (10 kademeli sunucu yetkili abonelik sistemi, Smart UI motoru, çoklu ajan yazılım hattı, kota yönetimi) **sağlam temeller üzerine kurulmuştur**. Ancak denetim sırasında **kritik çalışma engelleyici** ve **yüksek riskli**
 sorunlar tespit edilmiştir. Bu bulgular, Aşama 2'de sırayla ve gerçek veriler bozulmadan onarılacaktır.

**En kritik bulgu:** Kullanıcı tarafından bildirilen "Groq 404" hatası **yapısal bir kusur değil, modellerin hizmet dışı kalmasıdır**. Platformun tüm kaskadında kapanmış model kimlikleri sabitlenmiştir:

| Model ID | Sağlayıcı | Kapanış | Etkisi |
|---|---|---|---|
| `mixtral-8x7b-32768` | Groq | 20.03.2025 | 404 DÖNÜYOR |
| `llama-3.3-70b-versatile` | Groq | 16.08.2026 (yalnızca Enterprise) | 404 DÖNÜYOR |
| `llama-3.1-8b-instant` | Groq | 16.08.2026 (yalnızca Enterprise) | 404 DÖNÜYOR |
| `gemini-2.0-flash` | Google Gemini | Güncellenmiş aile | 404 DÖNÜYOR |
| `gemini-1.5-pro` | Google Gemini | Kapanmış | 404 DÖNÜYOR |

Kaynak: sağlayıcı dokümantasyonlarında yayımlanan model kapatma planları (deprecation notices). Güncel doğrulanmış üretim modelleri:
- **Groq:** `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` (önizleme)
- **Gemini:** `gemini-4-argon` (amiral gemisi), `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`

---

## 2. MİMARİ GENEL BAKIŞ

### 2.1 Dosya Envanteri
| Dosya | Satır | Rol |
|---|---|---|
| `main.py` | 1.223 | FastAPI servisi, uç noktalar, kota, CORS |
| `models_provider.py` | 379 | Model katmanı & kaskad (ANA ONARIM HEDEFİ) |
| `subscriptions.py` | 369 | 10 paket tanımı + Custom fiyat motoru |
| `smart_ui.py` | 108 | Smart UI şema & sanitizasyon |
| `app.js` | ~2.836 | Frontend motoru |
| `index.html` | ~2.931 | UI & stil |
| `sw.js` | — | Servis çalışanı |
| `config.js` | — | Firebase web config (HATALI appId içerir) |
| `firestore.rules` / `storage.rules` | — | Güvenlik kuralları |
| `google-services.json` / `firabase.json` | — | Android config (✗ Web değil) |
| `lumina_memory.json` | — | Yerel hafıza deposu |

### 2.2 Çalışma Durumu
- ✅ Sunucu başlatılabilir ve `/api/v1/health` **200** döndürür.
- ❌ `POST /api/v1/chat` → **500** ("Tüm yapay zeka model sağlayıcıları meşgul veya yapılandırılmamış").
- ⚙️ `.env` ve `serviceAccountKey.json` YOK → yerel hafıza & misafir modu aktif.

---

## 3. BULGULAR (KRİTİKLİK SIRASIYLA)

### 🔴 KRİTİK B1 — Models_provider: Tüm Kaskad Kapanmış Modeller
`select_model_candidates()` fonksiyonundaki **tüm** model kimlikleri (3 kademe) kapanmış modellerdir. Hiçbir API anahtarı geçerli olsa bile çağrılar 404 döndürür; kullanıcı alttaki asıl model hatasını değil kaskad çöküşünü görür.
**Onarım:** Aşama 2'de kaskad tamamen yenilenecek; hata koduna göre davranış (404→atla, 429→backoff, 401/403→yetki hatası, 5xx→ağ hatası sıradakine geç) ve üstel geri çekilme (exponential backoff) eklenecek. Yeni model seti (Groq OSS + Gemini 3.8/3.6/3.5/3.1/4-Argon) tanımlanacak.

### 🔴 KRİTİK B2 — Frontend: 12 Fonksiyon Referans Edilmiş, Tanımlanmamış
`app.js` içinde çağrılan ama **hiç** tanımlanmamış fonksiyonlar:
`openPlansModal, closePlansModal, renderPlanCards, renderComparisonTable, switchPlansTab, onCustomSliderChange, selectCustomPlan, selectCustomModelTier, sendFamilyInvite, fetchSubscriptionDetails, triggerDocUpload, handleDocUpload, clearAttachedDoc, renderSmartUI`

Bu durumda:
- 💎 **Paketler modal'ı tamamen kırılmıştır** (kullanıcı hiçbir paketi göremez/seçemez).
- Belge ekleme akışı hiç çalışmaz.
- **Smart UI** backend'de üretilir ama frontend'de renderer olmadığı için grafikte görünmez.
**Onarım:** Tüm eksik fonksiyonlar mevcut mimariye uyumlu şekilde eklenecek.

### 🔴 KRİTİK B3 — CORS Aşırı Geniş
`allow_origin_regex = r"https?://.*"` — sunucuyu **internetten gelen her siteden** istek kabul etmeye açar. `allow_credentials=True` ile birlikte bu güvenlik deliğidir.
**Onarım:** Sıkı beyaz liste (+ `ALLOWED_ORIGINS` env ile genişletme) uygulanacaktır.

### 🟠 YÜKSEK B4 — Kota Yarış Durumu (Race Condition)
`check_and_increment_quota()` → oku-arttır-yaz döngüsü `_STORE_LOCK` dışında yapılır. Eşzamanlı isteklerde sayaç kayar, kota aşılabilir.
**Onarım:** Tek `_STORE_LOCK` altında bir per-uid atomik işlemle güncellenir.

### 🟠 YÜKSEK B5 — Firebase Web AppID YANLIŞ
`config.js` → `appId: "1:523006120281:android:3e72abe43fc1c05a7a3c48"` — bu bir **Android** appId'idir; web'e bağlanamaz. Doğru web appId Firebase Console'dan alınmalı. Web config'de *uydurulmaYACAK*, eksik durum Türkçe olarak bildirilecek.

### 🟠 YÜKSEK B6 — verify_token Haklanan Hata Yönetimi
Firebase token doğrulanamadığında sessizce "Misafir Kullanıcı" döndürülüyor → tanıması amacı riskli oturum davranışı.
**Onarım:** Firebase aktifken tiket doğrulaması 401 ile yanıt verecek.

### 🟡 ORTA B7 — Belge Analizi Sadece düz Metin
`/api/v1/documents/analyze` sadece UTF-8 decode. PDF ve DOCX destekler.
**Onarım:** DOCX (zip→word/document.xml) ve PDF (pypdf, opsiyonel) destekleri eklenecek.

### 🟡 ORTA B8 — Tavily API Anahtarı Gövdede
API key request body'de `api_key` alanında; modern API `Authorization: Bearer` header'ı istiyor.
**Onarım:** Header kullanımına geçilecek.

### 🟡 ORTA B9 — GitHub Models Uç Noktası Kalkmakta:
`models.inference.ai.azure.com` uç noktası güncel olmayabilir; yeni uç `https://models.github.ai/inference/chat/completions` + kuruluş öneki mantığı.
**Onarım:** Yeni uç birincil, eski uç yedek olacak.

### 🟡 ORTA B10 — Görsel Üretim Yalnızca Pollinations
`gemini-nano-banana-2.1` üzerinden resmi resim üretimi eksik.
**Onarım:** Gemini `v1beta/interactions` REST'e geçiş + Pollinations fallback korunur.

### 🟢 DÜŞÜK B11 — Aile/Duo Üyelik Planı Yayılmıyor
Üyeler davet edilir ama paket seviyesi üyeye yayılmaz → davete karşılık gelen Firebase e-posta kullanıcıları Standart pakette kalır.
**Onarım:** Davet kayıtları üzerinden plan yayılım mekanizması eklenecek.

### 🟢 DÜŞÜK B12 — Erişilebilirlik & Klavye
`<meta name="viewport">` içinde `user-scalable=no` (yakınlaştırma yasak) mevcut; bazı `aria` etiketleri eksik:
**Onarım:**
- `user-scalable=no` kaldırma
- focus yönetimi ve aria etiketleri güçlendirme
- Kullanıcıya dönük hata mesajlarının tamamen Türkçeleştirilmesi

### 🟢 DÜŞÜK B13 — `firebase.auth().signOut()` inline HTML'de
Mimari tutarlılığı için JS modülüne taşınacak.

### 🟢 DÜŞÜK B14 — Karma Dil Alanları
Bazı İngilizce log mesajları ve görsel istem şablonları Türkçeleştirilmemiş. Onarımda kullanıcıya dönük tüm mesajlar Türkçeleştirilecek; istem (prompt) şablonları model kalitesi için İngilizce kalabilir.

---

## 4. GÜVENLİK & OPERASYONEL RİSK TABLOSU

| № | Risk | Ciddiyet | Olasılık | Kademeli Onarım (Aşama 2) |
|---|---|---|---|---|
| R1 | Kapanmış model çocuk kaskadına çarpma | Kritik | %100 | models_provider yenileme |
| R2 | CORS kastrollo→CSRF/cross-site | Kritik | yüksek | Sıkı origin listesi |
| R3 | Kota race→kota aşımı | Yüksek | orta | Atomik sayaç |
| R4 | Çekirdek UI kırık (plans) | Kritik | %100 | app.js fonksiyonlar |
| R5 | Smart UI XSS | Düşük-Orta | düşük | sanitize + şema (mevcut iyi) |
| R6 | Firebase appId yanlış | Yüksek | kesin | Console'dan web appId |
| R7 | Ödeme sağlayıcısı yapılandırılmamış (canlı ödeme yok) | Bilgilendirme | — | Veri modeli kurulu olur; canlı ödeme taklit edilmez, "önizleme" durumu açıkça etiketlenir |

---

## 5. DOĞRULANMIŞ DIŞ SERVİS DURUMU (16.10.2026)

### 5.1 Groq
- İyi durumda: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` (önizleme)
- Kapanmış: `mixtral-8x7b-32768`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` (yalnızca Enterprise)

### 5.2 Google Gemini
- Metin: `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`
- Resim: `gemini-nano-banana-2.1` (REST `v1beta/interactions`, `store:false`) + Pollinations fallback (misafir/flux)

### 5.3 GitHub Models
- Yeni uç: `POST https://models.github.ai/inference/chat/completions` (model öneki zorunlu, ör. `openai/gpt-4o-mini`)
- Eski uç: `models.inference.ai.azure.com` → yedek kaskad

### 5.4 Tavily & DuckDuckGo
- Tavily `Bearer` header'a geçilecek; DDG anlık API fallback kalır.

### 5.5 Firebase
- Proje `lumina-ai-a42e0` (gerçek). Web appId Console'dan alınması için boşluğunuz var — **uydurulmadı**.
- `serviceAccountKey.json` yolu `.env`'den verilecektir.

---

## 6. AŞAMA 2 & SONRASI PLANI (ÖZET)
1. ✍️ `models_provider.py` — Model kataloğu/ kaskad + Turkish hata taksonomisi + backoff
2. 📁 `storage.py` — Yeni: atomic lokal JSON + Firestore opsiyonel mirror soyutlaması
3. 🔧 `main.py` — Sıkı CORS, atomik kota, üye plan yayılımı, `images_per_conversation`, 401, DOCX/PDF analizi, `attached_document`, smart-ui strip, Nano Banana görsel + `/media` statik servis
4. 📊 `subscriptions.py` — yeni güncel model_tier metinleri, sunucunun "önizleme" ödeme durumu netliği
5. 🖥️ `app.js`/`index.html` — eksik 14 fonksiyon, Smart UI renderer, belge akışı, streaming+stop, erişilebilirlik
6. 🧪 `tests/` — pytest + TestClient (mock'lu) / canlı entegrasyon testleri ayrı dosyada, anahtar gerektiği için BOŞ çalışır
7. 📄 **FİNAL RAPOR:** 14 maddelik detaylı Türkçe ürün raporu

---

*Bu rapor Aşama 2 kodculuk başlamadan önce durumu güçlendirilmiş olarak dökümante eder. Onarımlardan sonra `.env.example`, README, GUVENLIK_VE_KURULUM.md güncellenecektir.*
