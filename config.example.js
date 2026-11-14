// ============================================================
// LUMINA AI - ORNEK YAPILANDIRMA DOSYASI (CONFIG.EXAMPLE.JS)
// ============================================================
// Bu dosyayı "config.js" olarak kopyalayabilir ve anahtarlarınızı girebilirsiniz.
//
// GÜVENLİK UYARISI:
//   Bu dosya TARAYICIYA gönderilir; buradaki her değer herkes tarafından
//   okunabilir. Bu yüzden buraya Groq/Google/Azure SUNUCU anahtarları,
//   yönetici token'ı veya misafir imza sırrı YAZMAYIN. Bu sırlar yalnızca
//   sunucu ortam değişkenlerinde (.env) tutulur.
//   Kullanıcıya ait kişisel anahtarlar Ayarlar menüsünden girilir ve yalnızca
//   o cihazın localStorage'ında saklanır.

window.LUMINA_CONFIG = {
    // 1. Google Gemini API Anahtarı (https://aistudio.google.com/app/apikey)
    //    İSTEĞE BAĞLI / KİŞİSEL KULLANIM. Paylaşılan ortamda boş bırakın.
    GEMINI_API_KEY: "",

    // 2. Groq API Anahtarı (https://console.groq.com/keys)
    //    İSTEĞE BAĞLI / KİŞİSEL KULLANIM. Çok kullanıcılı üretimde sunucu
    //    tarafındaki GROQ_KEY_01..20 havuzunu kullanın; buraya yazmayın.
    GROQ_API_KEY: "",

    // 3. GitHub Personal Access Token / PAT veya Repo Variable
    //    İSTEĞE BAĞLI / KİŞİSEL KULLANIM.
    GITHUB_TOKEN: "",

    // 4. Uzak Backend URL'si (HTTPS ZORUNLU)
    //    Örn: "https://ornek-backend.example.com/api/v1"
    //    - Yerel geliştirmede boş bırakılırsa http://127.0.0.1:8000/api/v1 kullanılır.
    //    - Üretimde (GitHub Pages) boşsa uygulama localhost'a istek ATMAZ ve
    //      uydurma bir adres üretmez; açıkça "backend yok" durumuna düşer.
    //    - Üretimde yalnızca HTTPS kabul edilir; http:// ve localhost reddedilir.
    BACKEND_URL: "",

    // 5. Firebase Web Yapılandırması (lumina-ai-a42e0)
    FIREBASE_CONFIG: {
        apiKey: "", // Firebase Web API Anahtarınız (Firebase Console -> Proje Ayarları -> Web Uygulaması)
        authDomain: "lumina-ai-a42e0.firebaseapp.com",
        projectId: "lumina-ai-a42e0",
        storageBucket: "lumina-ai-a42e0.firebasestorage.app",
        messagingSenderId: "523006120281",
        appId: "" // Web App ID (örn: 1:523006120281:web:...)
    },

    // 6. Harita / Konum (İSTEĞE BAĞLI)
    //    Google Maps JavaScript API tarayıcı anahtarı BURAYA YAZILMAZ.
    //    Backend, kısıtlı tarayıcı anahtarını yalnızca oturum açmış
    //    istemcilere /api/v1/location/config üzerinden verir.
    //    Anahtar yoksa harita OpenStreetMap (Leaflet) ile gösterilir.
    LOCATION_ENABLED: true
};
