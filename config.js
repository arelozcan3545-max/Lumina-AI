// ============================================================
// LUMINA AI - ISTEMCI VE GITHUB YAPILANDIRMASI (CONFIG.JS)
// ============================================================
// Bu dosya GitHub Pages, GitHub Repository Variables veya
// yerel sunucusuz kullanımlarda ortam değişkenlerini tanımlamanızı sağlar.

window.LUMINA_CONFIG = {
    // 1. Google Gemini API Anahtarı (https://aistudio.google.com/app/apikey)
    GEMINI_API_KEY: "",

    // 2. Groq API Anahtarı (https://console.groq.com/keys)
    GROQ_API_KEY: "",

    // 3. GitHub Personal Access Token / PAT veya Repo Variable
    GITHUB_TOKEN: "",

    // 4. İsteğe Bağlı Uzak Backend URL'si
    // Boş bırakılırsa yerel sunucu (http://127.0.0.1:8000/api/v1) kullanılır.
    BACKEND_URL: "",

    // 5. Firebase Web Yapılandırması (lumina-ai-a42e0)
    // Değerler google-services.json dosyasından alınmıştır.
    // NOT: google-services.json yalnızca Android uygulaması içerir; burada
    // kullanılan appId Android appId'sidir. Firebase Console'da bir WEB
    // uygulaması oluşturulursa appId mutlaka web appId ile değiştirilmelidir.
    // apiKey istemci tarafında görünür; gizli anahtar DEĞİLDİR. Yine de
    // Firebase Console > API anahtarları bölümünden HTTP referrer kısıtlaması
    // uygulanması önerilir.
    FIREBASE_CONFIG: {
        apiKey: "AIzaSyDLFO-qqooGlRePsyJ-LmvlKL9TuTRmWXM",
        authDomain: "lumina-ai-a42e0.firebaseapp.com",
        projectId: "lumina-ai-a42e0",
        storageBucket: "lumina-ai-a42e0.firebasestorage.app",
        messagingSenderId: "523006120281",
        appId: "1:523006120281:android:3e72abe43fc1c05a7a3c48"
    }
};
