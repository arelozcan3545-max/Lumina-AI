// ============================================================
// LUMINA AI - ORNEK YAPILANDIRMA DOSYASI (CONFIG.EXAMPLE.JS)
// ============================================================
// Bu dosyayı "config.js" olarak kopyalayabilir ve anahtarlarınızı girebilirsiniz.

window.LUMINA_CONFIG = {
    // 1. Google Gemini API Anahtarı (https://aistudio.google.com/app/apikey)
    GEMINI_API_KEY: "",

    // 2. Groq API Anahtarı (https://console.groq.com/keys)
    GROQ_API_KEY: "",

    // 3. GitHub Personal Access Token / PAT veya Repo Variable
    GITHUB_TOKEN: "",

    // 4. İsteğe Bağlı Uzak Backend URL'si (boş ise yerel: http://127.0.0.1:8000/api/v1)
    BACKEND_URL: "",

    // 5. Firebase Web Yapılandırması (lumina-ai-a42e0)
    FIREBASE_CONFIG: {
        apiKey: "", // Firebase Web API Anahtarınız (Firebase Console -> Proje Ayarları -> Web Uygulaması)
        authDomain: "lumina-ai-a42e0.firebaseapp.com",
        projectId: "lumina-ai-a42e0",
        storageBucket: "lumina-ai-a42e0.firebasestorage.app",
        messagingSenderId: "523006120281",
        appId: "" // Web App ID (örn: 1:523006120281:web:...)
    }
};
