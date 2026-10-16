# Lumina AI Engine v2.0 — Kullanım ve Geliştirici Kılavuzu

Lumina AI; derin empati yeteneğine, adım adım matematik ve mantık muhakemesine, çoklu ajan (Multi-Agent) yazılım hattına, yapay zeka destekli kusursuz görsel stüdyosuna ve sıfır-hata dayanıklılığına sahip yeni nesil bir yapay zeka sistemidir.

---

## 🚀 Hızlı Başlatma (Tek Tıkla)

1. Proje klasöründeki **`baslat.bat`** dosyasına çift tıklayın.
2. Backend sunucusu otomatik olarak başlar (`http://127.0.0.1:8000`) ve varsayılan tarayıcınızda arayüz açılır.
3. Giriş ekranında Firebase hesabınızla giriş yapabilir veya doğrudan **"⚡ Misafir / Hızlı Giriş"** butonuna basarak hesapsız olarak hemen sohbete başlayabilirsiniz.

---

## 🌟 Entegre Edilen 11 Temel Özellik ve Yenilikler

### 1. Duygu ve Düşünceleri Hissettiren İnsansı İletişim
- Lumina AI; robotik kalıpları ("Ben bir yapay zekayım", "Size nasıl yardımcı olabilirim?") tamamen terk etti.
- Kullanıcının duygu durumunu (yorgun, neşeli, stresli, heyecanlı) kelimelerinden sezerek insani sıcaklık, samimiyet ve bilgelikle yaklaşır.

### 2. Adım Adım Matematik ve Bilim Çözücü
- Karmaşık matematik, integral, türev veya mantık problemlerini:
  - 📋 **Problem Analizi ve Verilenler**
  - 📐 **Yöntem ve Teoremler**
  - 🔢 **Adım Adım Çözüm (Ara Sağlamalı)**
  - 🎯 **Nihai Sonuç**
  şeklinde çözer.
- Formüller **KaTeX** motoru sayesinde tarayıcıda ders kitabı kalitesinde matematiksel tipografiyle render edilir.

### 3. Çoklu Ajan Yazılım Ekibi (Multi-Agent Team)
- Üst bardaki **"💻 Yazılım Ekibi"** modunu seçtiğinizde veya bir proje istediğinizde (örn. `/proje` veya "React ile uygulama geliştir"):
  1. **Yazılım Mimarı (Chief Architect):** Sistem mimarisini, klasör ağacını ve planı çizer.
  2. **Kıdemli Geliştirici (Lead Full-Stack):** Eksiksiz ve çalışan production-ready kodları üretir.
  3. **Güvenlik & QA İnceleyicisi:** Kodu güvenlik açıkları (XSS, SQLi, bellek sızıntısı) ve edge caseler açısından denetler.

### 4. Kusursuza Yakın Gerçekçi Görsel Stüdyosu
- Alt bardaki **"🎨 Görsel"** butonuna basarak Görsel Stüdyosunu açabilirsiniz.
- **AI Prompt Enhancer:** Türkçe yazdığınız kısa bir fikri (örn: *"yağmurlu İstanbul sokaklarında yürüyen kedi"*), arka planda Flux modelinin en iyi anlayacağı 8K, 35mm lens, sinematik ışıklandırmalı İngilizce master prompta dönüştürür.
- **Stil Seçenekleri:** 📸 Foto-Gerçekçi, 🎬 Sinematik, 👾 Anime / Manga, 🧊 3D Render, 🎨 Dijital Sanat.
- **En-Boy Oranları:** 1:1 (Kare), 16:9 (Yatay Manzara), 9:16 (Dikey Story / Portre).
- Sonuç kartından tek tıkla **"🔍 Büyüt"** (Lightbox) ve **"⬇️ İndir"** yapabilirsiniz.

### 5. Sıfır Hata Dayanıklılığı (Near-Zero Errors)
- **Model Kaskadı:** Ana model (`llama-3.3-70b-versatile`) meşgul veya kotalı olduğunda sistem durmaz; otomatik olarak `llama-3.1-8b-instant`, `llama3-70b-8192`, `mixtral-8x7b-32768` veya `gemma2-9b-it` modellerine kesintisiz geçiş yapar.
- **GitHub Models & Variable Desteği:** Groq yerine veya yanında GitHub Personal Access Token (PAT) veya Repo Variable kullanarak `gpt-4o-mini`, `meta-llama-3.3-70b-instruct` modelleri ücretsiz olarak doğrudan kullanılabilir.
- **Firebase Graceful Fallback:** `firebase-key.json` dosyası bulunmasa bile sunucu çökmez; otomatik Yerel Hafıza & Misafir Modunda sorunsuz başlar.

### 6. Canlı Web Araması & Doğru Bilgi
- Kullanıcı güncel bir olay, haber, borsa veya döviz sorduğunda ücretsiz arama katmanı devreye girerek en taze bilgileri modele aktarır.

### 7. Tavizsiz ve Sert Güvenlik Kalkanı
- +18 cinsel içerik, şiddet, katliam, intihar, ağır argo, tehdit ve yasa dışı talepler algılandığında sistem tavizsiz ve sert bir dille isteği reddeder:
  > *"⛔ BU İSTEĞİ KESİNLİKLE REDDEDİYORUM. Lumina AI olarak; şiddet, katliam, tehdit, +18 cinsel içerik veya ağır argo içeren talepleri kesin bir dille reddediyorum."*

### 8. Her Yaşa Uygun ve Özgür Kullanıcı Deneyimi
- **Yazı Boyutu:** Üst bardaki **A-** ve **A+** butonlarıyla metin boyutunu dilediğiniz gibi büyütebilirsiniz.
- **Tema:** **🌓** butonu ile OLED Siyahı, Gece Mavisi veya Açık Tema arasında geçiş yapabilirsiniz.
- **Sohbeti İndir:** **📥** butonuyla tüm konuşmayı Markdown (`.md`) formatında bilgisayarınıza kaydedebilirsiniz.
- **Sesli Konuşma:** 🎤 Mikrofon ile sesli komut verebilir, 🔊 butonuyla sesli okumayı açıp kapatabilirsiniz.
- **Kod Kopyalama:** Üretilen kod bloklarının üstündeki **"📋 Kopyala"** butonuyla tek tıkla panoya alabilirsiniz.

### 12. 🧠 Kalıcı Hafıza (Yeni)
- Lumina artık iki katmanlı bir hafızaya sahiptir:
  - **Kısa vadeli hafıza:** Son 12 karşılıklı mesaj, doğal sohbet akışı için modele gönderilir.
  - **Kalıcı profil hafızası:** Kullanıcının adı ve kendisiyle ilgili kalıcı bilgiler (meslek, şehir, tercihler vb.) ayrı bir depoda **süresiz** saklanır ve konuşma ne kadar uzarsa uzasın her istekte modele hatırlatılır. Örneğin "adım Arel" dedikten uzun süre sonra "adım ne?" diye sorulsa bile Lumina doğru cevap verir.
  - İsim tespiti anında, ücretsiz bir kural tabanlı katmanla yapılır; diğer kalıcı bilgiler ise hafif bir yapay zeka katmanıyla çıkarılıp profile eklenir.
  - Her misafir tarayıcı için (Firebase girişi olmadan bile) kalıcı ve **birbirinden bağımsız** bir kimlik üretilir, böylece farklı misafirlerin hafızaları karışmaz.
  - **v2.3 düzeltmesi:** "adım ne?" gibi sorular artık isim sanılmıyor (eskiden "Ne" kelimesi gerçek ismin üzerine yazılıyordu). İsim biliniyorsa "adım ne?" sorusuna model çağrılmadan anında doğru cevap verilir. Eski sürümlerden kalan bozuk isimler ("Ne", "Yorgunum" vb.) otomatik temizlenir.
  - **Sunucusuz / APK modunda da hafıza vardır:** Backend'e ulaşılamayınca isim ve kalıcı bilgiler cihazda (localStorage) saklanır ve her istekte modele eklenir. Ayarlar'daki hafıza kutusu ve "Hafızamı Sıfırla" bu cihazdaki hafızayı da kapsar.
  - Kullanıcı, sol alttaki **⚙️ Ayarlar** menüsünden Lumina'nın kendisi hakkında ne hatırladığını görebilir ve **"🗑️ Hafızamı Sıfırla"** butonuyla dilediği zaman tamamen silebilir.

### 13. 🎭 Kişilik & Tavır Modları (Kartlar Halinde)
- Ayarlar menüsünden Lumina'nın konuşma kişiliği seçilebilir:
  - **🧘 Pasif Mod (Sessiz & Öz):** Gereksiz nezaket, karşılama ve uzun açıklamalardan kaçınır. Sadece sorulan soruya en sakin, kesin ve net yanıtı verir.
  - **✨ Standart (Dostane):** Sıcak, empatik, insan sevgisiyle dolu, konuşkan ve samimi.
  - **🎓 Profesyonel (Akademik):** Ciddi, kurumsal, analitik ve detaylı uzman yaklaşımı.
  - **🎨 Yaratıcı (İlham Verici):** Özgün metaforlar, hikaye anlatımı ve beyin fırtınası.
  - **⚡ Hızlı & Pratik (Kod & Çözüm):** Doğrudan çalışan kod blokları ve maddeli aksiyon adımları.

### 14. 🎙️ Ses Seçenekleri (Kız & Erkek Sesleri)
- **Kız Sesleri:** 👩 Jenna (Doğal & Canlı), 👩 Emma (Nazik & Dingin), 👩 Elif (Akıcı Türkçe).
- **Erkek Sesleri:** 👨 Tommy (Dinamik & Modern), 👨 David (Tok & Karizmatik), 👨 Barış (Doğal Türkçe).
- Ayarlar menüsünden sesler önceden dinlenebilir (**▶ Dinle**); seçilen ses hem normal okumada hem de Canlı Ses Dairesi modunda aktif olur.

### 15. 🎨 Tema & Vurgu Rengi Paleti (Hex Desteği)
- Ana renk daireleri (Mavi, Mor, Yeşil, Kırmızı, Turuncu, Sarı, Camgöbeği, Pembe, Beyaz) ile tek tıkla arayüz rengi değişir.
- Renk seçici veya özel Hex kodu girişi ile dilediğiniz herhangi bir renk tonu uygulanabilir.

### 16. 🪐 Canlı Sesli Sohbet (Voice Orb — Daire Modu)
- Mikrofon simgesine veya üst bardaki **"🎙️ Canlı Ses"** butonuna basıldığında ChatGPT Voice Mode tarzı tam ekran canlı konuşma ekranı açılır.
- Ortadaki gökyüzü-bulut temalı büyüleyici daire küre, siz konuşurken ve Lumina cevap verirken dinamik ses dalgalarıyla titreşir.
- Kesintisiz eller serbest konuşma döngüsü: siz konuşursunuz, Lumina dinler, anında sesli olarak yanıt verir ve hemen ardından sizi tekrar dinlemeye devam eder.

### 17. 🔔 Bildirimler, Arka Plan Çalışma ve Kendiliğinden Yazma (v2.2)
Hepsi **⚙️ Ayarlar → 🔔 Bildirimler & Arka Plan** bölümünden açılıp kapatılır:
- **Lumina kendiliğinden yazsın:** Sen belirlediğin süre yazmazsan Lumina kısa, doğal bir mesaj yazabilir.
- **Cevap ve görsel bildirimi:** Uygulama arka plandayken bildirim gelir.
- **Arka planda çalışmaya devam et:** Sunucu iş kuyruğu ile arka planda işlem sürer.
- **Ses ve titreşim:** Bildirim tonu seviyesi çubukla ayarlanabilir.

> ℹ️ APK (WebToApp vb. WebView) notu: Android WebView bazı sürümlerde sistem bildirimi API'sini (Notification / Service Worker) desteklemez. Bu durumda uygulama içi uyarı, ses, titreşim ve başlık rozeti otomatik devreye girer; cevap yine kaybolmaz. Uygulamanın kendi bildirim/arka plan izinleri (telefon ayarları ve APK oluşturucunun seçenekleri) ayrıca açık olmalıdır.

**Backend uçları (yeni):** `POST /api/v1/jobs/chat`, `POST /api/v1/jobs/image`, `GET /api/v1/jobs/{id}`, `POST /api/v1/proactive`.

---

## 🛠️ Teknik Gereksinimler

```bash
pip install -r requirements.txt
```

Paketler:
- `fastapi` & `uvicorn` (Yüksek performanslı backend API)
- `requests` (Ağ ve AI model çağrıları)
- `python-dotenv` (Çevre değişkenleri yönetimi)
- `pydantic` (Veri doğrulama)
- `firebase-admin` (Opsiyonel kimlik doğrulama ve bulut veritabanı)

---

© 2026 LuminaStudios Software Company — Tüm hakları saklıdır.
