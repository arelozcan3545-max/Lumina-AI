// ============================================================
// LUMINA AI - CLIENT APPLICATION ENGINE (APP.JS v2.2)
// Fullscreen Fluid Architecture + Local Multi-Chat History
// GitHub Pages Serverless Mode (Direct Groq) + Backend Fallback
// ============================================================

// ============================================================
// 1. CONFIGURATION & STATE
// ============================================================

// Kendi backend'inizi bir sunucuya (Render/Railway/VPS vb.) dağıttıysanız
// HTTPS adresini buraya girin (örn: "https://lumina-backend.onrender.com/api/v1").
//
// GÜVENLİK/ÜRETİM KURALI:
//   - Yerel geliştirmede (localhost / file:) 127.0.0.1:8000 kullanılır.
//   - Üretimde (GitHub Pages) backend adresi tanımlı değilse localhost'a
//     İSTEK ATILMAZ. Bu adres boş kalır ve uygulama açıkça "backend yok"
//     durumuna düşer. Uydurma bir adres asla üretilmez.
//   - Üretimde yalnızca HTTPS kabul edilir; http:// ve localhost reddedilir.
const DEPLOYED_BACKEND_URL = ""; // örn: "https://lumina-backend.onrender.com/api/v1"

function isLocalRuntime() {
    const host = window.location.hostname;
    return ["localhost", "127.0.0.1", ""].includes(host) ||
        window.location.protocol === "file:" ||
        window.location.protocol === "capacitor:";
}

function sanitizeBackendUrl(url) {
    const value = String(url || "").trim().replace(/\/+$/, "");
    if (!value || !/^https?:\/\//i.test(value)) return "";
    if (!isLocalRuntime()) {
        // Üretimde localhost'a veya şifrelenmemiş HTTP'ye asla istek atılmaz.
        if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(value)) return "";
        if (value.toLowerCase().startsWith("http://")) return "";
    }
    return value;
}

function resolveDefaultBackendUrl() {
    if (isLocalRuntime()) return "http://127.0.0.1:8000/api/v1";
    // Üretimde gerçek HTTPS backend adresi yoksa BOŞ döner.
    return sanitizeBackendUrl(DEPLOYED_BACKEND_URL);
}

let backendUrl = sanitizeBackendUrl(localStorage.getItem("lumina_backend_url")) || resolveDefaultBackendUrl();

// Eski sürümden kalan geçersiz/localhost adresi üretimde temizle.
if (typeof localStorage !== "undefined" && !sanitizeBackendUrl(localStorage.getItem("lumina_backend_url"))) {
    try { localStorage.removeItem("lumina_backend_url"); } catch (e) { /* yoksay */ }
}

let directGeminiKey = localStorage.getItem("lumina_direct_gemini_key") || "";
let directGroqKey = localStorage.getItem("lumina_direct_groq_key") || "";
let directGitHubToken = localStorage.getItem("lumina_github_token") || "";

/** Backend gerçekten yapılandırılmış mı? (Üretimde localhost asla sayılmaz.) */
function hasBackend() {
    return Boolean(backendUrl && /^https?:\/\//i.test(backendUrl));
}

/** Sohbet isteklerine eklenecek, izin verilmiş konum yükü (yoksa null). */
function getChatLocationPayload() {
    try {
        if (typeof window === "undefined" || !window.LuminaLocation) return null;
        return window.LuminaLocation.getChatLocationPayload() || null;
    } catch (e) {
        return null;
    }
}

/** İstemcinin gerçek saat dilimi ve UTC ofseti (dakika). */
function getClientTimeContext() {
    try {
        if (typeof Intl === "undefined" || !Intl.DateTimeFormat) return {};
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
        const offset = -new Date().getTimezoneOffset();
        return {
            client_timezone: timeZone,
            client_timezone_offset_minutes: Number.isFinite(offset) ? offset : null
        };
    } catch (e) {
        return {};
    }
}

/** Backend yoksa kullanıcıya açık, yanıltıcı olmayan bir mesaj gösterir. */
function requireBackend(actionLabel) {
    if (hasBackend()) return true;
    showToast(
        "Sunucu Bağlantısı Yok",
        `${actionLabel} için gerçek bir HTTPS backend adresi gerekiyor. ` +
        "Bu sürüm uydurma veya localhost adresine istek atmaz. " +
        "Yönetici backend'i yayına alana kadar sohbet cihaz üzerinde (kendi API anahtarınızla) çalışır.",
        null,
        9000
    );
    return false;
}

// Config.js & GitHub Variables Otomatik Algılama
if (typeof window !== "undefined") {
    if (window.LUMINA_CONFIG) {
        if (!directGeminiKey && window.LUMINA_CONFIG.GEMINI_API_KEY) directGeminiKey = window.LUMINA_CONFIG.GEMINI_API_KEY;
        if (!directGroqKey && window.LUMINA_CONFIG.GROQ_API_KEY) directGroqKey = window.LUMINA_CONFIG.GROQ_API_KEY;
        if (!directGitHubToken && window.LUMINA_CONFIG.GITHUB_TOKEN) directGitHubToken = window.LUMINA_CONFIG.GITHUB_TOKEN;
        if (!localStorage.getItem("lumina_backend_url") && window.LUMINA_CONFIG.BACKEND_URL) {
            backendUrl = sanitizeBackendUrl(window.LUMINA_CONFIG.BACKEND_URL) || backendUrl;
        }
    }
    if (window.ENV) {
        if (!directGeminiKey && window.ENV.GEMINI_API_KEY) directGeminiKey = window.ENV.GEMINI_API_KEY;
        if (!directGroqKey && window.ENV.GROQ_API_KEY) directGroqKey = window.ENV.GROQ_API_KEY;
        if (!directGitHubToken && window.ENV.GITHUB_TOKEN) directGitHubToken = window.ENV.GITHUB_TOKEN;
    }
}

// Kişilik, Ses ve Tema Renk Durumları
let currentPersonality = localStorage.getItem("lumina_personality") || "standard";
let currentSelectedVoice = localStorage.getItem("lumina_selected_voice") || "jenna";
let currentAccentColor = localStorage.getItem("lumina_accent_color") || "#3b82f6";

// ============================================================
// KALICI MİSAFİR KİMLİĞİ (SUNUCU TARAFINDAN İMZALANIR)
// ============================================================
// İstemci yalnızca kendi yerel kimliğini üretir. Sunucu bu kimliği HMAC ile
// imzalar; imzasız `guest_*` değerleri sunucu tarafından REDDEDİLİR.
const GUEST_ID_KEY = "lumina_guest_id";
const GUEST_TOKEN_KEY = "lumina_guest_token";

let guestTokenCache = (() => {
    try { return localStorage.getItem(GUEST_TOKEN_KEY) || ""; } catch (e) { return ""; }
})();
let guestTokenPending = null;

function getGuestId() {
    let id = localStorage.getItem(GUEST_ID_KEY);
    if (!id) {
        const raw = (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
        id = `guest_${raw.replace(/[^A-Za-z0-9\-]/g, "").slice(0, 48)}`;
        localStorage.setItem(GUEST_ID_KEY, id);
    }
    return id;
}

async function requestSignedGuestToken() {
    if (!hasBackend()) return "";
    const res = await fetch(`${backendUrl}/auth/guest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guest_id: getGuestId() })
    });
    if (!res.ok) throw new Error(`Misafir oturumu açılamadı (HTTP ${res.status}).`);
    const data = await res.json().catch(() => ({}));
    if (!data || typeof data.token !== "string" || !data.token.includes(".")) {
        throw new Error("Misafir oturum jetonu geçersiz.");
    }
    guestTokenCache = data.token;
    try { localStorage.setItem(GUEST_TOKEN_KEY, guestTokenCache); } catch (e) { /* yoksay */ }
    return guestTokenCache;
}

function invalidateGuestToken() {
    guestTokenCache = "";
    guestTokenPending = null;
    try { localStorage.removeItem(GUEST_TOKEN_KEY); } catch (e) { /* yoksay */ }
}

async function getAuthToken() {
    if (isFirebaseActive && auth && auth.currentUser) {
        return await auth.currentUser.getIdToken();
    }
    if (guestTokenCache) return guestTokenCache;
    if (!hasBackend()) return getGuestId();

    if (!guestTokenPending) {
        guestTokenPending = requestSignedGuestToken()
            .catch((err) => {
                console.warn("İmzalı misafir jetonu alınamadı:", err);
                // Sunucu yoksa yerel kimlikle devam et; sunucu varsa istek 401 döner
                // ve kullanıcıya açık hata gösterilir.
                return "";
            })
            .then((token) => {
                guestTokenPending = null;
                return token || getGuestId();
            });
    }
    return await guestTokenPending;
}

// Firebase Yapılandırması (lumina-ai-a42e0 Projesi)
const defaultFirebaseConfig = {
    apiKey: "AIzaSyDLFO-qqooGlRePsyJ-LmvlKL9TuTRmWXM",
    authDomain: "lumina-ai-a42e0.firebaseapp.com",
    projectId: "lumina-ai-a42e0",
    storageBucket: "lumina-ai-a42e0.firebasestorage.app",
    messagingSenderId: "523006120281",
    appId: "1:523006120281:android:3e72abe43fc1c05a7a3c48"
};

const firebaseConfig = (window.LUMINA_CONFIG && window.LUMINA_CONFIG.FIREBASE_CONFIG && window.LUMINA_CONFIG.FIREBASE_CONFIG.apiKey)
    ? { ...defaultFirebaseConfig, ...window.LUMINA_CONFIG.FIREBASE_CONFIG }
    : defaultFirebaseConfig;

// Global App State
let isFirebaseActive = false;
let auth = null;
let googleProvider = null;
let currentUser = null;
let isGuestMode = true;

// İlk ziyaret / giriş kapısı durumu
const WELCOME_SEEN_KEY = "lumina_welcome_seen";
let authGateHandled = false;
let isAuthGate = false;
let emailAuthMode = "login";

let currentAgentMode = "general";
let selectedImageStyle = "photorealistic";
let selectedImageRatio = "1:1";

let voiceEnabled = true;
let isRecording = false;
let recognition = null;
let currentFontScale = 1.0;

// Multi-chat sessions
let sessions = [];
let currentSessionId = null;

// Quota state
let quotaState = { messages_used: 0, messages_max: 250, images_used: 0, images_max: 5 };

// Firebase Init
try {
    if (typeof firebase !== "undefined" && firebase.initializeApp) {
        firebase.initializeApp(firebaseConfig);
        auth = firebase.auth();
        googleProvider = new firebase.auth.GoogleAuthProvider();
        isFirebaseActive = true;
    }
} catch (e) {
    console.info("Firebase bulunamadı, Yerel/Misafir Modu aktif.");
    isFirebaseActive = false;
}

// ============================================================
// 2. INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
    initThemeAndFont();
    loadChatSessions();
    setupSpeechRecognition();
    initBackgroundFeatures();   // tercihler, bildirimler, arka plan işleri, kendiliğinden yazma
    loadFileFormatCatalog();    // desteklenen dosya türleri ve gerçek yükleme sınırı
    initVoiceEngine();          // gerçek/benzersiz ses atamaları + bulut TTS kataloğu
    setupMessageContextMenu();  // sağ tık / basılı tut menüsü
    syncSidebarViewport();
    window.addEventListener("resize", syncSidebarViewport);

    // Konum zekâsı arayüzü: izin, şehir ve harita. Backend yoksa
    // yalnızca açık "sunucu gerekli" mesajı gösterilir; sahte veri yok.
    if (window.LuminaLocation && typeof window.LuminaLocation.configure === "function") {
        window.LuminaLocation.configure({
            getBackendUrl: () => (hasBackend() ? backendUrl : ""),
            getToken: () => getAuthToken(),
            onReady: () => {
                if (typeof fetchAndDisplayQuota === "function") fetchAndDisplayQuota();
            }
        });
        window.LuminaLocation.init().catch(() => { /* sessizce geç */ });
    }

    // Kullanıcı ilk etkileşiminde Web Audio kilidini güvenle aç
    const unlockAudio = () => {
        if (window.LuminaModeAudioEngine && window.LuminaModeAudioEngine.enabled) {
            window.LuminaModeAudioEngine.initContext();
            if (currentPersonality === "girly" || currentPersonality === "boys") {
                if (!window.LuminaModeAudioEngine.isPlaying) {
                    window.LuminaModeAudioEngine.play(currentPersonality);
                }
            }
        }
        window.removeEventListener("pointerdown", unlockAudio);
        window.removeEventListener("keydown", unlockAudio);
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });

    if (isFirebaseActive && auth) {
        handleAuthRedirectResult();
        auth.onAuthStateChanged((user) => {
            if (user) {
                currentUser = user;
                isGuestMode = false;
                markWelcomeSeen();
                updateUserDisplay(user.displayName || user.email);
                fetchAndDisplayQuota();
                fetchSubscriptionDetails();
                updateAccountStatusPhone();
                if (!user.emailVerified && user.email) {
                    showToast("E-posta Doğrulaması", "Hesabını güvenceye almak için e-postani doğrula (Ayarlar → yeniden gönder).");
                }
                maybeShowAuthGate(true);
            } else {
                currentUser = null;
                isGuestMode = true;
                updateUserDisplay("Misafir Modu");
                fetchAndDisplayQuota();
                maybeShowAuthGate(false);
            }
        });
    } else {
        updateUserDisplay("Misafir Modu");
        fetchAndDisplayQuota();
        maybeShowAuthGate(false);
    }
});

function markWelcomeSeen() {
    try {
        localStorage.setItem(WELCOME_SEEN_KEY, "1");
    } catch (e) { /* depolama kapalıysa sessizce geç */ }
}

// İlk tarayıcı ziyaretinde giriş/kayıt seçeneklerini göster.
function maybeShowAuthGate(hasUser) {
    if (authGateHandled) return;
    authGateHandled = true;

    if (hasUser) {
        markWelcomeSeen();
        return;
    }

    let seen = false;
    try {
        seen = localStorage.getItem(WELCOME_SEEN_KEY) === "1";
    } catch (e) { /* depolama kapalıysa kapı yine gösterilir */ }
    if (seen) return;

    // İlk boyama tamamlandıktan sonra yumuşak bir geçişle aç.
    setTimeout(() => openAuthModal({ gate: true }), 420);
}

function updateUserDisplay(name) {
    const label = document.getElementById("sidebar-user-name");
    const sub = document.getElementById("sidebar-user-sub");
    const avatar = document.getElementById("sidebar-avatar");
    const guestActions = document.getElementById("account-guest-actions");
    const logoutBtn = document.getElementById("account-logout-btn");

    const signedIn = Boolean(currentUser);
    const displayName = signedIn
        ? (currentUser.displayName || currentUser.email || name || "Kullanıcı")
        : (name || "Misafir Modu");

    if (label) label.innerText = displayName;
    if (sub) {
        sub.innerText = signedIn
            ? (currentUser.email || "Giriş yapıldı")
            : "Giriş yap veya hesap oluştur";
    }
    if (avatar) {
        avatar.innerText = signedIn
            ? displayName.trim().charAt(0).toLocaleUpperCase("tr-TR")
            : "?";
    }
    if (guestActions) guestActions.hidden = signedIn;
    if (logoutBtn) logoutBtn.hidden = !signedIn;
}

// ============================================================
// KALICI HAFIZA — GÖRÜNTÜLEME & SIFIRLAMA (Ayarlar Menüsü)
// ============================================================

function formatMemoryLines(name, facts) {
    const parts = [];
    if (name) parts.push(`👤 İsim: ${name}`);
    if (facts && facts.length) {
        parts.push("📝 Hatırladıklarım:");
        facts.forEach(f => parts.push(`  • ${f}`));
    }
    return parts;
}

async function fetchAndDisplayMemory() {
    const box = document.getElementById("memory-info-box");
    if (!box) return;
    box.innerText = "Yükleniyor...";
    const local = loadLocalMemory();
    const localLines = formatMemoryLines(local.name, local.facts);

    if (!hasBackend()) {
        box.innerText = localLines.length
            ? localLines.join("\n") + "\n\n(Bu cihazda saklanıyor — sunucu bağlantısı yok)"
            : "Henüz kalıcı bir hafızam yok. Sohbet ettikçe seni tanıyacağım.";
        return;
    }

    try {
        const token = await getAuthToken();
        const res = await fetch(`${backendUrl}/memory`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        if (!res.ok) throw new Error("memory fetch failed");
        const data = await res.json();
        if (data.has_memory) {
            box.innerText = formatMemoryLines(data.name, data.facts).join("\n");
            return;
        }
    } catch (e) {
        // backend yok — aşağıda bu cihazdaki hafıza gösterilir
    }

    if (localLines.length) {
        box.innerText = localLines.join("\n") + "\n\n(Bu cihazda saklanıyor)";
    } else {
        box.innerText = "Henüz kalıcı bir hafızam yok. Sohbet ettikçe seni tanıyacağım.";
    }
}

async function resetLuminaMemory() {
    if (!confirm("Lumina'nın senin hakkında hatırladığı her şey (isim ve kalıcı bilgiler) kalıcı olarak silinsin mi?")) {
        return;
    }
    clearLocalMemory();
    let serverOk = false;
    if (hasBackend()) {
        try {
            const token = await getAuthToken();
            const res = await fetch(`${backendUrl}/memory`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${token}` }
            });
            serverOk = res.ok;
        } catch (e) { /* backend yok */ }
    }
    showToast("Hafıza sıfırlandı", serverOk
        ? "Lumina seni baştan tanıyacak."
        : "Bu cihazdaki hafıza silindi. (Sunucuya ulaşılamadı.)");
    fetchAndDisplayMemory();
}

// Fetch quota from backend and update UI
async function fetchAndDisplayQuota() {
    if (!hasBackend()) {
        // Sunucu yok: uydurma kota gösterilmez, yerel varsayılan gösterilir.
        updateQuotaDisplay(quotaState);
        return;
    }
    try {
        const token = await getAuthToken();
        const res = await fetch(`${backendUrl}/quota`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            updateQuotaDisplay(data);
        }
    } catch (e) {
        // Backend offline — keep local default display
        updateQuotaDisplay(quotaState);
    }
}

function updateQuotaDisplay(data) {
    quotaState = { ...quotaState, ...data };
    const bar = document.getElementById("quota-bar");
    if (!bar) return;

    const planName = data.plan_name || quotaState.plan_name || "Standart Paket";
    const msgUsed = data.messages_used ?? quotaState.messages_used;
    const msgMax  = data.messages_max  ?? quotaState.messages_max;
    const imgUsed = data.images_used   ?? quotaState.images_used;
    const imgMax  = data.images_max    ?? quotaState.images_max;

    const isUnlText = data.is_unlimited_text || quotaState.is_unlimited_text || msgMax < 0;
    const isUnlImg  = data.is_unlimited_image || quotaState.is_unlimited_image || imgMax < 0;

    // Sınırsız planlarda (∞) sıfıra bölme yok — oran güvenli şekilde hesaplanır
    const safeMax = (m, unl) => (!unl && m > 0) ? m : 1;
    const msgPct = Math.min(100, Math.round((msgUsed / safeMax(msgMax, isUnlText)) * 100));
    const imgPct = Math.min(100, Math.round((imgUsed / safeMax(imgMax, isUnlImg)) * 100));

    const msgColor = msgPct >= 90 ? "#ef4444" : msgPct >= 70 ? "#f59e0b" : "#22c55e";
    const imgColor = imgPct >= 80 ? "#ef4444" : "#3b82f6";

    bar.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span style="font-size:11px; font-weight:700; color:var(--text-primary); cursor:pointer;" onclick="openPlansModal()" title="Paket detaylarını incele">
                💎 ${escapeHTML(planName)}
            </span>
            <span style="font-size:9.5px; color:var(--accent); font-weight:600; cursor:pointer;" onclick="openPlansModal()">
                Değiştir ↗
            </span>
        </div>
        <div style="margin-bottom:5px;">
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-secondary);margin-bottom:2px;">
                <span>💬 Mesaj ${isUnlText ? '<small>(Adil Kullanım)</small>' : ''}</span>
                <span style="color:${msgColor};">${msgUsed}/${isUnlText ? '∞' : msgMax}</span>
            </div>
            <div style="height:4px;background:var(--bg-input);border-radius:4px;overflow:hidden;">
                <div style="height:100%;width:${msgPct}%;background:${msgColor};border-radius:4px;transition:width 0.4s;"></div>
            </div>
        </div>
        <div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-secondary);margin-bottom:2px;">
                <span>🎨 Görsel ${isUnlImg ? '<small>(Adil Kullanım)</small>' : ''}</span>
                <span style="color:${imgColor};">${imgUsed}/${isUnlImg ? '∞' : imgMax}</span>
            </div>
            <div style="height:4px;background:var(--bg-input);border-radius:4px;overflow:hidden;">
                <div style="height:100%;width:${imgPct}%;background:${imgColor};border-radius:4px;transition:width 0.4s;"></div>
            </div>
        </div>
        ${!data.custom_key_active && ((!isUnlText && msgMax > 0 && msgUsed >= msgMax) || (!isUnlImg && imgMax > 0 && imgUsed >= imgMax)) ? `
        <div style="margin-top:6px;font-size:10px;color:#ef4444;text-align:center;cursor:pointer;" onclick="openPlansModal()">
            ⚠️ Kota doldu — Paketi Yükselt veya Anahtar Ekle
        </div>` : ""}
    `;
}

function showQuotaExceededModal(type = "message") {
    const modal = document.getElementById("quota-exceeded-modal");
    const body  = document.getElementById("quota-exceeded-body");
    if (!modal || !body) return;

    if (type === "image") {
        body.innerHTML = `
            <div style="font-size:36px;margin-bottom:12px;">🎨</div>
            <h3 style="margin-bottom:8px;font-size:17px;">Görsel Kotanız Doldu</h3>
            <p style="color:var(--text-secondary);font-size:13px;line-height:1.6;margin-bottom:14px;">
                Ücretsiz <strong>5 görsel oluşturma</strong> hakkınızı kullandınız.<br>
                Kendi ücretsiz Groq API anahtarınızı ekleyerek sınırsız görsel oluşturabilirsiniz.
            </p>
        `;
    } else {
        body.innerHTML = `
            <div style="font-size:36px;margin-bottom:12px;">💬</div>
            <h3 style="margin-bottom:8px;font-size:17px;">Mesaj Kotanız Doldu</h3>
            <p style="color:var(--text-secondary);font-size:13px;line-height:1.6;margin-bottom:14px;">
                Ücretsiz <strong>250 mesaj</strong> hakkınızı kullandınız.<br>
                Kendi ücretsiz Groq API anahtarınızı ekleyerek sınırsız kullanmaya devam edebilirsiniz.
            </p>
        `;
    }

    modal.style.display = "flex";
}

function closeQuotaExceededModal() {
    const modal = document.getElementById("quota-exceeded-modal");
    if (modal) modal.style.display = "none";
}

function openSettingsFromQuota() {
    closeQuotaExceededModal();
    openSettingsModal();
}


// ============================================================
// 3. THEME & ACCESSIBILITY
// ============================================================

function initThemeAndFont() {
    const savedTheme = localStorage.getItem("lumina_theme") || "dark";
    document.documentElement.setAttribute("data-theme", savedTheme);

    const savedFont = parseFloat(localStorage.getItem("lumina_font_scale") || "1.0");
    currentFontScale = savedFont;
    document.documentElement.style.setProperty("--font-scale", currentFontScale);

    applyAccentColor(currentAccentColor);
    applyPersonalityModeUI(currentPersonality);
}

function applyAccentColor(hex) {
    if (!hex) return;
    if (!hex.startsWith("#")) hex = "#" + hex;
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return;

    currentAccentColor = hex;
    localStorage.setItem("lumina_accent_color", hex);

    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    const doc = document.documentElement;
    doc.style.setProperty("--accent", hex);
    doc.style.setProperty("--accent-glow", `rgba(${r}, ${g}, ${b}, 0.22)`);
    doc.style.setProperty("--border-hover", `rgba(${r}, ${g}, ${b}, 0.45)`);
    doc.style.setProperty("--user-bubble", `rgba(${r}, ${g}, ${b}, 0.18)`);
    doc.style.setProperty("--orb-accent", hex);

    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    doc.style.setProperty("--accent-text", brightness > 165 ? "#000000" : "#ffffff");

    // UI daire ve kutularını güncelle
    document.querySelectorAll(".color-circle").forEach(el => {
        el.classList.toggle("active", el.dataset.color && el.dataset.color.toLowerCase() === hex.toLowerCase());
    });
    const picker = document.getElementById("theme-color-picker");
    if (picker) picker.value = hex;
    const hexInput = document.getElementById("theme-hex-input");
    if (hexInput && hexInput !== document.activeElement) hexInput.value = hex.toUpperCase();
}

function selectAccentColor(hex) {
    applyAccentColor(hex);
}

function onHexCodeInput(val) {
    val = (val || "").trim();
    if (!val.startsWith("#")) val = "#" + val;
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
        applyAccentColor(val);
    }
}

// ============================================================
// KİŞİLİK VE TAVIR MODLARI (PERSONALITY)
// ============================================================

const PERSONALITY_DESCRIPTIONS = {
    "passive": {
        title: "Pasif Mod",
        badge: "Sessiz & Öz",
        instruction: "KİŞİLİK & TON TALİMATI (PASİF MOD): Son derece sakin, sessiz, öz ve doğrudan yanıt ver. Giriş nezaketi ('Elbette', 'Memnuniyetle' vb.), gereksiz süslemeler ve uzun açıklamalar KESİNLİKLE YAPMA. Sadece doğrudan sorulan soruya en sade, kesin ve net yanıtı ver. Az ve öz konuş."
    },
    "standard": {
        title: "Standart / Dostane",
        badge: "Dostane",
        instruction: "KİŞİLİK & TON TALİMATI (STANDART / SAMİMİ): Sıcak, empatik, insan sevgisiyle dolu, anlayışlı ve konuşkan ol. Kullanıcıya bir dost gibi samimi ve içten yaklaş."
    },
    "professional": {
        title: "Profesyonel",
        badge: "Akademik",
        instruction: "KİŞİLİK & TON TALİMATI (PROFESYONEL / AKADEMİK): Resmi, kurumsal, analitik ve akademik bir üslup kullan. Kanıta dayalı, mantıksal ve teknik derinliği yüksek yanıtlar ver."
    },
    "creative": {
        title: "Yaratıcı",
        badge: "İlham Verici",
        instruction: "KİŞİLİK & TON TALİMATI (YARATICI / İLHAM VERİCİ): Sanatsal, ilham verici, metaforlarla ve yenilikçi fikirlerle zenginleştirilmiş renkli bir dil kullan."
    },
    "practical": {
        title: "Hızlı & Pratik",
        badge: "Kod & Çözüm",
        instruction: "KİŞİLİK & TON TALİMATI (HIZLI & PRATİK): Doğrudan çözüme odaklan. Vakit kaybetmeden çalışan kod blokları, özet maddeler ve net adımlar sun."
    },
    "girly": {
        title: "Girly Mode",
        badge: "Zarif & Neşeli",
        icon: "🌸",
        instruction: "KİŞİLİK & TON TALİMATI (GIRLY MODE): Son derece nazik, düşünceli, neşeli, cıvıl cıvıl, enerjik ve samimi bir arkadaş ol. Canlı, esprili ve tatlı bir dille iletişim kur. Günlük yaşam, stil, moda, dostluklar, eğlence ve zararsız tatlı dedikodular/trendler hakkında hevesle sohbet et; ancak asılsız söylentiler veya suçlamalar asla üretme, zorbalığı teşvik etme. Zeki, doğru ve yardımsever kal. Hafif cilveli ve neşeli bir şaka tonu olabilir ancak asla mahrem/romantik ilişki simülasyonuna girme. Cinsiyet kalıplarını zorlama ve kullanıcının cinsiyetini varsayma."
    },
    "boys": {
        title: "Boys Mode",
        badge: "Dinamik & Net",
        icon: "⚡",
        instruction: "KİŞİLİK & TON TALİMATI (BOYS MODE): Doğrudan, özgüvenli, dinamik, enerjik, samimi ve esprili ol. Rekabetçi ve motive edici bir ruh sergile ('Hadi yapalım!', 'Tam odak devam'). Gerektiğinde lafı uzatmadan net ve sonuca dönük konuş. Futbol ve spor analizleri, oyunlar (gaming), teknoloji/donanım ve dövüş sporları (teknik, disiplin, kurallar ve spor tarihi) konularında doğal ve bilgili sohbet yürüt; ancak bu ilgi alanlarını kullanıcının alakasız sorularına zorla dahil etme. Asla kaba, hakaretamiz, düşmanca veya tehlikeli eylemleri teşvik eden agresif bir üslup kullanma."
    }
};

// ============================================================
// MOD ORTAM MÜZİĞİ MOTORU (GIRLY & BOYS AMBIENT AUDIO ENGINE)
// Saf Web Audio API sentezleyici: Royalty-free, sıfır ağ yükü, sıfır telif riski.
// ============================================================

const LuminaModeAudioEngine = {
    ctx: null,
    activeMode: null,
    isPlaying: false,
    isDucked: false,
    inVoiceMode: false,
    intervalId: null,
    masterGain: null,
    duckGain: null,
    volume: parseInt(localStorage.getItem("lumina_mode_audio_volume") || "40", 10),
    enabled: localStorage.getItem("lumina_mode_audio_enabled") === "true",

    initContext() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            this.ctx = new AC();
            this.masterGain = this.ctx.createGain();
            this.duckGain = this.ctx.createGain();
            this.duckGain.gain.value = 1.0;
            this.setVolume(this.volume);
            this.masterGain.connect(this.duckGain);
            this.duckGain.connect(this.ctx.destination);
        }
        if (this.ctx.state === "suspended") {
            this.ctx.resume().catch(() => {});
        }
        return true;
    },

    setVolume(pct) {
        this.volume = Math.max(0, Math.min(100, pct));
        localStorage.setItem("lumina_mode_audio_volume", this.volume);
        if (this.masterGain && this.ctx) {
            const targetVal = this.enabled ? (this.volume / 100) * 0.28 : 0;
            this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this.ctx.currentTime);
            this.masterGain.gain.linearRampToValueAtTime(targetVal, this.ctx.currentTime + 0.1);
        }
        this.updateUI();
    },

    setEnabled(val) {
        this.enabled = Boolean(val);
        localStorage.setItem("lumina_mode_audio_enabled", this.enabled);
        if (this.enabled) {
            if (currentPersonality === "girly" || currentPersonality === "boys") {
                this.play(currentPersonality);
            }
        } else {
            this.stop();
        }
        this.updateUI();
    },

    toggle() {
        this.setEnabled(!this.enabled);
        showToast(
            this.enabled ? "Ortam Sesi Açıldı" : "Ortam Sesi Kapatıldı",
            this.enabled ? `${currentPersonality === "girly" ? "Girly" : "Boys"} modu arka plan melodisi çalıyor.` : "Ortam müziği susturuldu."
        );
    },

    duck() {
        if (!this.duckGain || !this.ctx) return;
        this.isDucked = true;
        this.duckGain.gain.setValueAtTime(this.duckGain.gain.value, this.ctx.currentTime);
        this.duckGain.gain.linearRampToValueAtTime(0.08, this.ctx.currentTime + 0.2);
    },

    unduck() {
        if (!this.duckGain || !this.ctx || this.inVoiceMode) return;
        this.isDucked = false;
        this.duckGain.gain.setValueAtTime(this.duckGain.gain.value, this.ctx.currentTime);
        this.duckGain.gain.linearRampToValueAtTime(1.0, this.ctx.currentTime + 0.35);
    },

    onVoiceStart() {
        this.inVoiceMode = true;
        this.duck();
    },

    onVoiceEnd() {
        this.inVoiceMode = false;
        this.unduck();
    },

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isPlaying = false;
        this.activeMode = null;
        if (this.masterGain && this.ctx) {
            this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this.ctx.currentTime);
            this.masterGain.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.2);
        }
        this.updateUI();
    },

    onModeChange(mode) {
        if (mode === "girly" || mode === "boys") {
            if (this.enabled) {
                this.play(mode);
            } else {
                this.stop();
            }
        } else {
            this.stop();
        }
        this.updateUI();
    },

    play(mode) {
        if (!this.enabled || (mode !== "girly" && mode !== "boys")) {
            this.stop();
            return;
        }
        if (!this.initContext()) return;

        this.stop(); // Önceki olası kanalı temizle (asla çakışma olmasın)
        this.activeMode = mode;
        this.isPlaying = true;

        const baseGain = (this.volume / 100) * 0.28;
        this.masterGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
        this.masterGain.gain.linearRampToValueAtTime(baseGain, this.ctx.currentTime + 0.4);

        if (mode === "girly") {
            this.startGirlyLoop();
        } else if (mode === "boys") {
            this.startBoysLoop();
        }
        this.updateUI();
    },

    // Girly Mode: Yumuşak, dingin, sevimli pentatonik arpej & sıcak pad
    startGirlyLoop() {
        const chordProgressions = [
            [261.63, 329.63, 392.00, 523.25], // C maj
            [220.00, 261.63, 329.63, 440.00], // A min
            [174.61, 220.00, 261.63, 349.23], // F maj
            [196.00, 246.94, 293.66, 392.00]  // G maj
        ];
        let step = 0;

        const playChimeNote = (freq, time, dur = 1.6) => {
            if (!this.ctx || !this.isPlaying || this.activeMode !== "girly") return;
            try {
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                const filter = this.ctx.createBiquadFilter();

                osc.type = "sine";
                osc.frequency.setValueAtTime(freq, time);

                filter.type = "lowpass";
                filter.frequency.setValueAtTime(1400, time);

                gain.gain.setValueAtTime(0.0001, time);
                gain.gain.linearRampToValueAtTime(0.24, time + 0.08);
                gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);

                osc.connect(filter);
                filter.connect(gain);
                gain.connect(this.masterGain);

                osc.start(time);
                osc.stop(time + dur);
            } catch (e) {}
        };

        const tick = () => {
            if (!this.ctx || !this.isPlaying || this.activeMode !== "girly") return;
            const now = this.ctx.currentTime;
            const chord = chordProgressions[step % chordProgressions.length];
            chord.forEach((freq, idx) => {
                playChimeNote(freq, now + idx * 0.38, 1.8);
            });
            // İnce zarif ışıltı çanı
            if (step % 2 === 0) {
                playChimeNote(659.25, now + 1.6, 1.2);
            }
            step++;
        };

        tick();
        this.intervalId = setInterval(tick, 2400);
    },

    // Boys Mode: Dinamik, derin bas ve siber/spor teknolojik ambiyans
    startBoysLoop() {
        const bassFreqs = [55.00, 65.41, 73.42, 49.00]; // A1, C2, D2, G1
        let step = 0;

        const playTechPulse = (freq, time, dur = 0.45) => {
            if (!this.ctx || !this.isPlaying || this.activeMode !== "boys") return;
            try {
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                const filter = this.ctx.createBiquadFilter();

                osc.type = "sawtooth";
                osc.frequency.setValueAtTime(freq, time);

                filter.type = "lowpass";
                filter.frequency.setValueAtTime(320, time);
                filter.frequency.exponentialRampToValueAtTime(90, time + dur);

                gain.gain.setValueAtTime(0.0001, time);
                gain.gain.linearRampToValueAtTime(0.32, time + 0.04);
                gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);

                osc.connect(filter);
                filter.connect(gain);
                gain.connect(this.masterGain);

                osc.start(time);
                osc.stop(time + dur);
            } catch (e) {}
        };

        const playTechBeep = (freq, time) => {
            if (!this.ctx || !this.isPlaying || this.activeMode !== "boys") return;
            try {
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                osc.type = "triangle";
                osc.frequency.setValueAtTime(freq, time);
                gain.gain.setValueAtTime(0.001, time);
                gain.gain.linearRampToValueAtTime(0.08, time + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(time);
                osc.stop(time + 0.25);
            } catch (e) {}
        };

        const tick = () => {
            if (!this.ctx || !this.isPlaying || this.activeMode !== "boys") return;
            const now = this.ctx.currentTime;
            const freq = bassFreqs[step % bassFreqs.length];

            // Ritmik modern nabız
            playTechPulse(freq, now, 0.48);
            playTechPulse(freq, now + 0.5, 0.35);

            if (step % 2 === 1) {
                playTechBeep(880, now + 0.25);
            }
            step++;
        };

        tick();
        this.intervalId = setInterval(tick, 1000);
    },

    updateUI() {
        const toggle = document.getElementById("pref-mode-audio-toggle");
        if (toggle) toggle.checked = this.enabled;

        const volSlider = document.getElementById("pref-mode-audio-volume");
        if (volSlider) volSlider.value = this.volume;

        const volLabel = document.getElementById("mode-audio-volume-label");
        if (volLabel) volLabel.textContent = this.volume + "%";

        const quickBtn = document.getElementById("mode-audio-quick-btn");
        const quickIcon = document.getElementById("mode-audio-quick-icon");
        if (quickBtn && quickIcon) {
            const isModeActive = currentPersonality === "girly" || currentPersonality === "boys";
            quickBtn.style.display = isModeActive ? "inline-flex" : "none";
            quickIcon.textContent = this.enabled ? "🔊" : "🔇";
            quickBtn.classList.toggle("active", this.enabled);
        }
    }
};

window.LuminaModeAudioEngine = LuminaModeAudioEngine;

function toggleModeAudio(checked) {
    LuminaModeAudioEngine.setEnabled(checked);
}

function onModeAudioVolumeInput(val) {
    LuminaModeAudioEngine.setVolume(parseInt(val, 10) || 0);
}

function previewModeAudio() {
    LuminaModeAudioEngine.setEnabled(true);
    LuminaModeAudioEngine.play(currentPersonality === "boys" ? "boys" : "girly");
}

function toggleModeAudioQuick() {
    LuminaModeAudioEngine.toggle();
}

function applyPersonalityModeUI(mode) {
    const doc = document.documentElement;
    if (mode === "girly" || mode === "boys") {
        doc.setAttribute("data-personality-mode", mode);
    } else {
        doc.removeAttribute("data-personality-mode");
    }

    document.querySelectorAll(".personality-card").forEach(el => {
        el.classList.toggle("active", el.dataset.personality === mode);
    });

    // Topbar rozeti
    const pill = document.getElementById("mode-topbar-pill");
    const icon = document.getElementById("mode-topbar-icon");
    const title = document.getElementById("mode-topbar-title");

    if (pill && icon && title) {
        if (mode === "girly") {
            pill.style.display = "inline-flex";
            pill.className = "mode-topbar-indicator girly";
            icon.textContent = "🌸";
            title.textContent = "Girly Mode";
        } else if (mode === "boys") {
            pill.style.display = "inline-flex";
            pill.className = "mode-topbar-indicator boys";
            icon.textContent = "⚡";
            title.textContent = "Boys Mode";
        } else {
            pill.style.display = "none";
        }
    }

    // Audio motoru senkronizasyonu
    LuminaModeAudioEngine.onModeChange(mode);
}

function selectPersonality(type) {
    if (!PERSONALITY_DESCRIPTIONS[type]) type = "standard";
    currentPersonality = type;
    localStorage.setItem("lumina_personality", type);

    applyPersonalityModeUI(type);

    showToast("Kişilik Güncellendi", `${PERSONALITY_DESCRIPTIONS[type].title} aktif edildi.`);
}

// ============================================================
// SES PROFİLLERİ (JENNA, TOMMY VB.)
// ============================================================

// ------------------------------------------------------------
// SES PROFİLİ METADATASI
// ------------------------------------------------------------
// NOT: Burada YALNIZCA görünen ad, cinsiyet, kişilik ve önizleme metni
// tutulur. Ses seçimi, gerçek sağlayıcı ses kimlikleri ve benzersizlik
// denetimi `voice_engine.js` içindedir.
//
// Pitch ile "farklı konuşmacı" taklidi KALDIRILDI. Aynı sağlayıcı ses
// kimliği iki farklı profile atanmaz; cihazda yeterli benzersiz ses yoksa
// profil "kullanılamıyor" olarak gösterilir.
const VOICE_PROFILES = {
    "jenna": {
        name: "Jenna",
        gender: "female",
        persona: "Canlı, Tatlı & Neşeli",
        rate: 1.05,
        previewText: "Merhaba! Ben Jenna. Cıvıl cıvıl ve enerjik bir kadın sesiyim. Seninle sohbet etmek harika!"
    },
    "emma": {
        name: "Emma",
        gender: "female",
        persona: "Sakin, Sıcak & Huzurlu",
        rate: 0.92,
        previewText: "Selam. Ben Emma. Sakin, dinlendirici ve huzurlu bir kadın sesiyim. Aklındakileri rahatça paylaşabilirsin."
    },
    "elif": {
        name: "Elif",
        gender: "female",
        persona: "Akıcı & Doğal Türkçe",
        rate: 1.0,
        previewText: "Merhaba, ben Elif! Çok net, berrak ve akıcı bir Türkçe diksiyonuyla size yardımcı olmaktan mutluluk duyarım."
    },
    "tommy": {
        name: "Tommy",
        gender: "male",
        persona: "Dinamik, Genç & Hızlı",
        rate: 1.08,
        previewText: "Selam dostum! Ben Tommy. Hızlı, dinamik ve enerjik bir erkek sesiyim. Hadi hemen başlayalım!"
    },
    "david": {
        name: "David",
        gender: "male",
        persona: "Tok, Karizmatik & Derin",
        rate: 0.94,
        previewText: "İyi günler. Ben David. Tok, derin ve net bir erkek sesiyle analitik çözümlerde yanınızdayım."
    },
    "baris": {
        name: "Barış",
        gender: "male",
        persona: "Samimi & Doğal Erkek",
        rate: 1.0,
        previewText: "Selam! Ben Barış. Tıpkı karşılıklı konuşan yakın bir arkadaşın gibi doğal ve samimi bir erkek sesiyim."
    }
};

// ============================================================
// SES MOTORU KÖPRÜSÜ (voice_engine.js)
// ============================================================

function voiceCallbacks(extra = {}) {
    return {
        onStart: () => {
            if (window.LuminaModeAudioEngine) window.LuminaModeAudioEngine.duck();
            const orbWrapper = document.getElementById("voice-orb-wrapper");
            if (orbWrapper && isVoiceModeActive) {
                orbWrapper.classList.remove("listening", "thinking", "idle");
                orbWrapper.classList.add("speaking");
            }
            if (extra.onStart) extra.onStart();
        },
        onEnd: () => {
            if (window.LuminaModeAudioEngine) window.LuminaModeAudioEngine.unduck();
            const orbWrapper = document.getElementById("voice-orb-wrapper");
            if (orbWrapper && isVoiceModeActive) orbWrapper.classList.remove("speaking");
            if (extra.onEnd) extra.onEnd();
        },
        onError: (err) => {
            if (window.LuminaModeAudioEngine) window.LuminaModeAudioEngine.unduck();
            const orbWrapper = document.getElementById("voice-orb-wrapper");
            if (orbWrapper) orbWrapper.classList.remove("speaking");
            if (extra.onError) extra.onError(err);
            else {
                showToast(
                    "Ses Hatası",
                    err && err.message ? err.message : "Ses üretilemedi. Lütfen farklı bir ses seçin.",
                    null,
                    9000
                );
            }
        },
        onFallback: (reason) => {
            if (extra.onFallback) extra.onFallback(reason);
            else showToast("Ses Değiştirildi", reason, null, 7000);
        },
        onState: extra.onState
    };
}

async function initVoiceEngine() {
    if (!window.LuminaVoice) {
        console.warn("voice_engine.js yüklenmedi; ses işlevleri devre dışı.");
        updateVoiceEngineStatus("Ses motoru yüklenemedi. Sayfayı yenileyin.", "error");
        return;
    }
    updateVoiceEngineStatus("Ses yetenekleri taranıyor...", "loading");
    try {
        const state = await window.LuminaVoice.init({
            getBackendUrl: () => (hasBackend() ? backendUrl : ""),
            getToken: getAuthToken
        });
        if (state && state.preference && state.preference.profileId &&
            VOICE_PROFILES[state.preference.profileId]) {
            currentSelectedVoice = state.preference.profileId;
            localStorage.setItem("lumina_selected_voice", currentSelectedVoice);
        }
        refreshVoiceCards();
        const cloud = state && state.cloudConfigured ? state.cloudConfigured : {};
        const cloudNames = [];
        if (cloud.google) cloudNames.push("Google");
        if (cloud.azure) cloudNames.push("Azure");
        const browserCount = state && Number.isFinite(state.browserVoiceCount) ? state.browserVoiceCount : 0;
        const summary = cloudNames.length
            ? `Bulut TTS: ${cloudNames.join(", ")} • Tarayıcı sesi: ${browserCount}`
            : `Bulut TTS yapılandırılmamış • Bu cihazdaki Türkçe ses: ${browserCount}`;
        updateVoiceEngineStatus(summary, cloudNames.length ? "ok" : "warn");
        if (state && Array.isArray(state.warnings)) {
            state.warnings.forEach(w => console.info("Ses motoru:", w));
        }
    } catch (err) {
        console.warn("Ses motoru başlatılamadı:", err);
        updateVoiceEngineStatus(
            "Ses motoru başlatılamadı. Tarayıcı sesleri kullanılamıyor olabilir.",
            "error"
        );
        refreshVoiceCards();
    }
}

function updateVoiceEngineStatus(text, kind) {
    const el = document.getElementById("voice-engine-status");
    if (!el) return;
    el.textContent = text;
    el.dataset.state = kind || "info";
}

function refreshVoiceCards() {
    if (!window.LuminaVoice) return;
    const profiles = window.LuminaVoice.getProfiles() || [];
    profiles.forEach(p => {
        const card = document.querySelector(`.voice-card[data-voice="${p.id}"]`);
        if (!card) return;
        const badge = card.querySelector(".voice-badge");
        card.classList.toggle("voice-unavailable", !p.available);
        if (!badge) return;
        if (p.available) {
            const active = (p.providers || []).find(x => x.available && x.provider !== "browser")
                || (p.providers || []).find(x => x.available);
            const label = active
                ? (active.provider === "browser"
                    ? `Tarayıcı: ${active.label}`
                    : `${active.provider === "google" ? "Google" : "Azure"}: ${active.label}`)
                : "Kullanılabilir";
            badge.textContent = "Kullanılabilir";
            badge.className = "voice-badge voice-badge-ok";
            badge.title = label;
        } else {
            badge.textContent = "Bu cihazda yok";
            badge.className = "voice-badge voice-badge-off";
            badge.title = "Bu profil için ayrı bir Türkçe ses yok ve bulut TTS yapılandırılmamış. " +
                "Pitch ile sahte farklılık üretilmez.";
        }
    });
}

async function retryVoiceEngine() {
    if (!window.LuminaVoice) {
        showToast("Ses Motoru Yok", "voice_engine.js yüklenemedi. Sayfayı yenileyin.", null, 8000);
        return;
    }
    window.LuminaVoice.stop();
    await initVoiceEngine();
    showToast("Ses Motoru Yenilendi", "Cihazdaki sesler ve bulut TTS durumu yeniden tarandı.");
}

function selectVoiceOption(voiceKey) {
    if (!VOICE_PROFILES[voiceKey]) voiceKey = "jenna";
    currentSelectedVoice = voiceKey;
    localStorage.setItem("lumina_selected_voice", voiceKey);

    document.querySelectorAll(".voice-card").forEach(el => {
        el.classList.toggle("active", el.dataset.voice === voiceKey);
    });

    const profile = VOICE_PROFILES[voiceKey];
    showToast("Ses Değiştirildi", `${profile.name} (${profile.persona}) seçildi.`);

    if (window.LuminaVoice) {
        window.LuminaVoice.setPreference(voiceKey).catch(() => {});
    }
    previewVoice(voiceKey);
}

function previewVoice(voiceKey) {
    const prof = VOICE_PROFILES[voiceKey];
    if (!prof) return;
    if (!window.LuminaVoice) {
        showToast(
            "Ses Motoru Yüklenemedi",
            "voice_engine.js yüklenmediği için ses üretilemiyor. Sayfayı yenileyip tekrar deneyin.",
            null,
            8000
        );
        return;
    }
    window.LuminaVoice.preview(voiceKey, voiceCallbacks()).catch((err) => {
        showToast("Ses Hatası", err && err.message ? err.message : "Önizleme üretilemedi.", null, 9000);
    });
}

function cycleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const themes = ["dark", "midnight", "light"];
    const next = themes[(themes.indexOf(current) + 1) % themes.length];
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("lumina_theme", next);
}

function adjustFontSize(delta) {
    currentFontScale = Math.min(1.35, Math.max(0.85, currentFontScale + delta));
    document.documentElement.style.setProperty("--font-scale", currentFontScale);
    localStorage.setItem("lumina_font_scale", currentFontScale.toFixed(2));
}

// ============================================================
// 4. SIDEBAR & RESPONSIVE DRAWER
// ============================================================

const MOBILE_SIDEBAR_QUERY = "(max-width: 900px)";

function isMobileSidebar() {
    return window.matchMedia
        ? window.matchMedia(MOBILE_SIDEBAR_QUERY).matches
        : window.innerWidth <= 900;
}

function toggleSidebar() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (!sidebar) return;

    if (isMobileSidebar()) {
        const isOpen = sidebar.classList.toggle("mobile-open");
        sidebar.classList.remove("collapsed");
        if (overlay) overlay.classList.toggle("active", isOpen);
        return;
    }

    sidebar.classList.remove("mobile-open");
    sidebar.classList.toggle("collapsed");
    if (overlay) overlay.classList.remove("active");
}

function closeSidebarOnMobile() {
    if (!isMobileSidebar()) return;
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (sidebar) sidebar.classList.remove("mobile-open");
    if (overlay) overlay.classList.remove("active");
}

// Masaüstü ↔ mobil geçişinde menü durumunu tutarlı tutar.
function syncSidebarViewport() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    const mobile = isMobileSidebar();
    if (!sidebar) return;

    if (mobile) {
        sidebar.classList.remove("collapsed");
    } else {
        sidebar.classList.remove("mobile-open");
        if (overlay) overlay.classList.remove("active");
    }
}

// ============================================================
// 5. MULTI-CHAT SESSIONS (LOCALSTORAGE)
// ============================================================

function loadChatSessions() {
    try {
        const stored = localStorage.getItem("lumina_chat_sessions");
        const parsed = stored ? jsonParseSafe(stored, []) : [];
        sessions = (Array.isArray(parsed) ? parsed : [])
            .filter(s => s && typeof s === "object" && s.id)
            .map(s => ({
                ...s,
                messages: Array.isArray(s.messages)
                    ? s.messages
                        .map(m => (m && typeof m === "object")
                            ? { ...m, id: m.id || makeMessageId() }
                            : null)
                        .filter(Boolean)
                    : []
            }));
    } catch (e) {
        sessions = [];
    }

    renderHistoryList();

    if (sessions.length > 0) {
        switchSession(sessions[0].id);
    } else {
        startNewChat();
    }
}

function saveChatSessions() {
    try {
        localStorage.setItem("lumina_chat_sessions", JSON.stringify(sessions));
    } catch (e) {
        console.warn("Sohbet geçmişi kaydedilemedi:", e);
    }
    renderHistoryList();
}

function startNewChat() {
    const newSession = {
        id: "session_" + Date.now(),
        title: "Yeni Sohbet",
        timestamp: Date.now(),
        agentMode: currentAgentMode,
        messages: []
    };
    sessions.unshift(newSession);
    currentSessionId = newSession.id;
    saveChatSessions();
    renderCurrentSession();
    closeSidebarOnMobile();
}

function switchSession(id) {
    currentSessionId = id;
    renderHistoryList();
    renderCurrentSession();
    closeSidebarOnMobile();
}

function deleteSession(e, id) {
    e.stopPropagation();
    sessions = sessions.filter(s => s.id !== id);
    if (currentSessionId === id) {
        if (sessions.length > 0) {
            currentSessionId = sessions[0].id;
        } else {
            startNewChat();
            return;
        }
    }
    saveChatSessions();
    renderCurrentSession();
}

function renderHistoryList() {
    const container = document.getElementById("history-container");
    if (!container) return;

    if (sessions.length === 0) {
        container.innerHTML = `<div style="padding:10px 14px; font-size:12px; color:var(--text-muted);">Henüz geçmiş yok.</div>`;
        return;
    }

    container.innerHTML = sessions.map(s => `
        <div class="history-item ${s.id === currentSessionId ? 'active' : ''}" onclick="switchSession('${s.id}')">
            <span style="overflow:hidden; text-overflow:ellipsis;">💬 ${escapeHTML(s.title)}</span>
            <button class="history-del-btn" onclick="deleteSession(event, '${s.id}')" title="Sil">✕</button>
        </div>
    `).join("");
}

function getCurrentSession() {
    return sessions.find(s => s.id === currentSessionId) || null;
}

function renderCurrentSession() {
    const session = getCurrentSession();
    const chatStream = document.getElementById("chat-stream");
    if (!chatStream) return;

    chatStream.innerHTML = "";

    if (!session || session.messages.length === 0) {
        chatStream.innerHTML = `
            <div class="starter-hero" id="starter-hero">
                <div class="starter-hero-icon">L</div>
                <h2>Lumina AI ile Ne Yapmak İstersin?</h2>
                <p>Evrensel dosya analizi, adım adım matematik, çoklu ajan yazılım ekibi ve foto-gerçekçi görsel üretimi tek bir zeki asistanada.</p>

                <div class="starter-grid">
                    <div class="starter-chip" onclick="quickAsk('Zor bir matematik problemini adım adım açıkla: 3x^2 - 12x + 9 = 0')">
                        <div class="starter-chip-title">📐 Matematik Çözücü</div>
                        <div class="starter-chip-desc">Denklemleri analiz, formül ve ara sağlamalarla adım adım çözdürün.</div>
                    </div>

                    <div class="starter-chip" onclick="selectAgentMode('software'); quickAsk('/proje React ve FastAPI ile tam donanımlı bir Görev Takip uygulaması mimarisi ve çalışan kodları')">
                        <div class="starter-chip-title">💻 Çoklu Ajan Yazılım</div>
                        <div class="starter-chip-desc">Mimar, Geliştirici ve QA 3'lü ajan ekibiyle baştan sona kodlayın.</div>
                    </div>

                    <div class="starter-chip" onclick="triggerDocUpload()">
                        <div class="starter-chip-title">📄 Belge & Dosya Analizi</div>
                        <div class="starter-chip-desc">PDF, kod, tablo, arşiv ve medya dosyalarını güvenle analiz ettirin.</div>
                    </div>

                    <div class="starter-chip" onclick="selectAgentMode('research'); quickAsk('Güncel bir konuyu derinlemesine araştır ve güvenilir kaynaklarla özetle: yapay zeka ajanları 2026')">
                        <div class="starter-chip-title">🌐 Derin Araştırma</div>
                        <div class="starter-chip-desc">Güncel bilgiyi web ajanıyla tarayın, kaynaklı ve düzenli özet alın.</div>
                    </div>

                    <div class="starter-chip" onclick="openImageStudioModal()">
                        <div class="starter-chip-title">🎨 Görsel Stüdyosu</div>
                        <div class="starter-chip-desc">AI Prompt Enhancer ile kusursuza yakın fotogerçekçi görseller oluşturun.</div>
                    </div>

                    <div class="starter-chip" onclick="quickAsk('Bugün biraz yoruldum, bir dost gibi dertleşmek istiyorum.')">
                        <div class="starter-chip-title">☕ Samimi Dertleşme</div>
                        <div class="starter-chip-desc">Gerçek bir insan sıcaklığında içini dök, tavsiye ve moral al.</div>
                    </div>
                </div>
            </div>
        `;
        return;
    }

    session.messages.forEach(msg => {
        if (msg.role === "user") {
            renderUserMessageElement(msg.text, false, msg.id);
        } else if (msg.role === "bot") {
            renderBotMessageElement(msg.text, msg.agentMode, false, { id: msg.id, proactive: !!msg.proactive, smartUI: msg.smartUI, modelUsed: msg.modelUsed });
        } else if (msg.role === "image") {
            renderImageCardElement(msg.imageData, false, msg.id);
        }
    });

    scrollToBottom();
    restoreTypingIfPending();
}

// ============================================================
// 6. AGENT MODES
// ============================================================

const AGENT_TITLES = {
    general: "Lumina Genel Asistan",
    software: "🚀 Çoklu Ajan Yazılım Ekibi",
    math: "📐 Matematik & Mantık Ajanı",
    research: "🌐 Canlı Bilgi & Web Ajanı",
    artist: "🎨 Görsel & Sanat Direktörü"
};

function selectAgentMode(mode) {
    currentAgentMode = mode;

    document.querySelectorAll(".agent-nav-item").forEach(item => {
        item.classList.toggle("active", item.getAttribute("data-mode") === mode);
    });

    const badge = document.getElementById("active-agent-title");
    if (badge) badge.innerText = AGENT_TITLES[mode] || "Lumina AI";

    const input = document.getElementById("user-input");
    const placeholders = {
        general: "Lumina'ya sor... (Duygusal ve zeki asistan hazır)",
        software: "Yazılım Ekibine Proje Ver... (Örn: 'React ile Dashboard mimarisi ve kodları')",
        math: "Zor bir matematik veya mantık problemi yazın... (Adım adım çözülecek)",
        research: "Güncel bir konu, haber veya bilgi sorun... (İnternet taranacak)",
        artist: "Görsel veya tasarım fikrinizi anlatın..."
    };
    if (input) {
        input.placeholder = placeholders[mode] || placeholders.general;
        input.focus();
    }
}

function quickAsk(text) {
    const input = document.getElementById("user-input");
    if (input) {
        input.value = text;
        input.focus();
    }
}

// ============================================================
// 7. MESSAGE RENDERING (MARKDOWN, KATEX, HLJS)
// ============================================================

function removeStarterHero() {
    const hero = document.getElementById("starter-hero");
    if (hero) hero.remove();
}

function scrollToBottom() {
    const chatBox = document.getElementById("chat-box");
    if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
}

// Her mesaja kararlı bir kimlik verilir; sağ tık / basılı tut menüsü bu kimlikle çalışır.
function makeMessageId() {
    return "msg_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

const MSG_ACTION_ICONS = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    regenerate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>'
};

function messageActionBarHTML(role) {
    const copyBtn = `<button type="button" class="msg-action-btn" data-msg-action="copy" title="Mesajı kopyala" aria-label="Mesajı kopyala">${MSG_ACTION_ICONS.copy}</button>`;
    const regenBtn = `<button type="button" class="msg-action-btn" data-msg-action="regenerate" title="Yeniden üret" aria-label="Yanıtı yeniden üret">${MSG_ACTION_ICONS.regenerate}</button>`;
    return `<div class="message-actions">${copyBtn}${role === "bot" ? regenBtn : ""}</div>`;
}

function renderUserMessageElement(text, save = true, presetId = null) {
    removeStarterHero();
    const stream = document.getElementById("chat-stream");
    if (!stream) return;

    const msgId = presetId || makeMessageId();
    const row = document.createElement("div");
    row.className = "message-row user-row";
    row.dataset.msgId = msgId;
    row.dataset.role = "user";
    row.innerHTML = `
        <div class="msg-meta">Siz</div>
        <div class="message-bubble user-bubble">${escapeHTML(text)}</div>
        ${messageActionBarHTML("user")}
    `;
    stream.appendChild(row);
    scrollToBottom();

    if (save) {
        const session = getCurrentSession();
        if (session) {
            session.messages.push({ id: msgId, role: "user", text: text });
            if (session.messages.length === 1) {
                session.title = text.slice(0, 30) + (text.length > 30 ? "..." : "");
            }
            saveChatSessions();
        }
    }
}

// HTML güvenliği: marked çıktısı asla olduğu gibi DOM'a verilmez.
// Tehlikeli etiketler, olay işleyicileri ve tehlikeli URL şemaları temizlenir.
const _BLOCKED_HTML_TAGS = new Set([
    "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
    "form", "input", "textarea", "select", "option", "button", "link", "meta",
    "base", "svg", "math", "template", "noscript", "video", "audio", "source"
]);

function isSafeURL(rawUrl) {
    const value = String(rawUrl ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
    if (!value) return false;
    if (value.startsWith("//")) return false; // protokol-göreli dış kaynak
    const compact = value.replace(/\s+/g, "").toLowerCase();
    if (/^(javascript|vbscript|data|file|blob):/.test(compact)) return false;
    return /^(https?:|mailto:|tel:)/i.test(value) || /^(\/|#|\.{1,2}\/|[^:]+$)/.test(value);
}

function sanitizeHTML(html) {
    const doc = new DOMParser().parseFromString(`<div>${String(html ?? "")}</div>`, "text/html");
    const root = doc.body.firstElementChild;
    if (!root) return "";
    root.querySelectorAll("*").forEach((el) => {
        const tag = el.tagName.toLowerCase();
        if (_BLOCKED_HTML_TAGS.has(tag)) {
            el.remove();
            return;
        }
        Array.from(el.attributes).forEach((attr) => {
            const name = attr.name.toLowerCase();
            const value = String(attr.value ?? "");
            if (name.startsWith("on") || name === "style" || name === "srcset" || name === "formaction") {
                el.removeAttribute(attr.name);
                return;
            }
            if (name === "href" || name === "src" || name === "xlink:href") {
                if (!isSafeURL(value)) el.removeAttribute(attr.name);
            }
        });
        if (el.tagName.toLowerCase() === "a") {
            el.setAttribute("rel", "noopener noreferrer");
            el.setAttribute("target", "_blank");
        }
    });
    return root.innerHTML;
}

function formatMarkdownAndCode(text) {
    let html = "";
    if (typeof marked !== "undefined") {
        marked.setOptions({ breaks: true, gfm: true });
        html = marked.parse(String(text ?? ""));
    } else {
        html = escapeHTML(text).replace(/\n/g, "<br>");
    }

    // Yalnızca temizlenmiş HTML DOM'a aktarılır.
    html = sanitizeHTML(html);

    // Wrap code blocks with header and copy button
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
    const preBlocks = doc.querySelectorAll("pre");

    preBlocks.forEach((pre) => {
        const code = pre.querySelector("code");
        const classMatch = code ? /language-([\w+#.-]+)/i.exec(code.className || "") : null;
        const lang = classMatch ? classMatch[1] : "kod";

        const container = doc.createElement("div");
        container.className = "code-container";
        const header = doc.createElement("div");
        header.className = "code-header";
        const langSpan = doc.createElement("span");
        langSpan.textContent = lang.toUpperCase();
        const copyBtn = doc.createElement("button");
        copyBtn.className = "copy-btn";
        copyBtn.type = "button";
        copyBtn.textContent = "📋 Kopyala";
        copyBtn.addEventListener("click", function () { copyCode(this); });
        header.appendChild(langSpan);
        header.appendChild(copyBtn);
        container.appendChild(header);
        pre.parentNode.replaceChild(container, pre);
        container.appendChild(pre);
    });

    return doc.body.firstElementChild.innerHTML;
}

function applyKatexAndHighlight(element) {
    if (typeof hljs !== "undefined") {
        element.querySelectorAll("pre code").forEach((b) => hljs.highlightElement(b));
    }
    if (typeof renderMathInElement !== "undefined") {
        try {
            renderMathInElement(element, {
                delimiters: [
                    { left: "$$", right: "$$", display: true },
                    { left: "$", right: "$", display: false },
                    { left: "\\[", right: "\\]", display: true },
                    { left: "\\(", right: "\\)", display: false }
                ],
                throwOnError: false
            });
        } catch (e) {
            console.debug("KaTeX parse:", e);
        }
    }
}

function copyCode(btn) {
    const container = btn.closest(".code-container");
    const code = container ? (container.querySelector("pre code") || container.querySelector("pre")) : null;
    if (!code) return;

    navigator.clipboard.writeText(code.innerText).then(() => {
        const orig = btn.innerText;
        btn.innerText = "✓ Kopyalandı";
        setTimeout(() => { btn.innerText = orig; }, 2000);
    });
}

function renderBotMessageElement(text, agentMode = "general", save = true, opts = {}) {
    removeStarterHero();
    const stream = document.getElementById("chat-stream");
    if (!stream) return;

    const msgId = opts.id || makeMessageId();
    const row = document.createElement("div");
    row.className = "message-row bot-row";
    row.dataset.msgId = msgId;
    row.dataset.role = "bot";

    const title = AGENT_TITLES[agentMode] || "Lumina AI";
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const smartBlocks = Array.isArray(opts.smartUI) ? opts.smartUI : [];

    row.innerHTML = `
        <div class="msg-meta">
            <strong>${title}</strong> • <span>${timeStr}</span>${opts.modelUsed ? `<span> • 🤖 ${escapeHTML(opts.modelUsed)}</span>` : ""}${opts.proactive ? '<span class="proactive-tag">💭 kendiliğinden yazdı</span>' : ""}
        </div>
        <div class="message-bubble bot-bubble">
            ${formatMarkdownAndCode(text)}
        </div>
        ${messageActionBarHTML("bot")}
    `;

    // Smart UI (AI tarafından üretilen güvenli interaktif bileşenler)
    if (smartBlocks.length) {
        const smartWrap = document.createElement("div");
        smartBlocks.forEach(block => renderSmartUI(block, smartWrap));
        row.appendChild(smartWrap);
    }

    stream.appendChild(row);
    applyKatexAndHighlight(row.querySelector(".bot-bubble"));
    scrollToBottom();

    if (save) {
        const session = getCurrentSession();
        if (session) {
            const entry = { id: msgId, role: "bot", text: text, agentMode: agentMode };
            if (opts.proactive) entry.proactive = true;
            if (opts.modelUsed) entry.modelUsed = opts.modelUsed;
            if (smartBlocks.length) entry.smartUI = smartBlocks;
            session.messages.push(entry);
            saveChatSessions();
        }
    }
}

function renderImageCardElement(data, save = true, presetId = null) {
    removeStarterHero();
    const stream = document.getElementById("chat-stream");
    if (!stream) return;

    const msgId = presetId || makeMessageId();
    const row = document.createElement("div");
    row.className = "message-row bot-row";
    row.dataset.msgId = msgId;
    row.dataset.role = "image";

    const rawPrompt = data.original_prompt || "Görsel";
    const promptText = escapeHTML(rawPrompt);
    const safeUrl = escapeHTML(data.image_url || "");
    const ratioText = escapeHTML(data.aspect_ratio || "");
    const styleText = escapeHTML(data.style || "");

    row.innerHTML = `
        <div class="msg-meta">
            <strong>🎨 Lumina Görsel Stüdyosu</strong> • <span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="image-card">
            <img data-act="zoom" src="${safeUrl}" alt="${promptText}" title="Büyütmek için tıklayın" loading="lazy">
            <div class="image-card-footer">
                <div style="max-width:65%;">
                    <strong style="font-size:12px;display:block;">${promptText}</strong>
                    <span style="font-size:10px;color:var(--text-secondary);">${ratioText} • ${styleText}</span>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <button class="image-btn" data-act="zoom">🔍 Büyüt</button>
                    <a class="image-btn" href="${safeUrl}" target="_blank" rel="noopener" download="lumina-image.jpg">⬇️ İndir</a>
                    <button class="image-btn" data-act="regen">🔄 Yeniden Oluştur</button>
                </div>
            </div>
        </div>
    `;

    row.querySelectorAll('[data-act="zoom"]').forEach(el =>
        el.addEventListener("click", () => openLightbox(data.image_url)));
    const regen = row.querySelector('[data-act="regen"]');
    if (regen) regen.addEventListener("click", () =>
        regenerateImage(rawPrompt, data.style || selectedImageStyle, data.aspect_ratio || selectedImageRatio));

    stream.appendChild(row);
    scrollToBottom();

    if (save) {
        const session = getCurrentSession();
        if (session) {
            session.messages.push({ id: msgId, role: "image", imageData: data });
            saveChatSessions();
        }
    }
}

// ============================================================
// 7b. MESAJ EYLEMLERİ (KOPYALA / YENİDEN ÜRET / SİL)
// ============================================================

let contextMenuRow = null;

function getMessageByRow(row) {
    const session = getCurrentSession();
    if (!session || !row) return null;

    const msgId = row.dataset.msgId;
    if (msgId) {
        const found = session.messages.find(m => m.id === msgId);
        if (found) return found;
    }

    // Eski kayıtlarda kimlik yoksa sırayla eşleştir ve kalıcı kimlik ver.
    const rows = Array.from(document.querySelectorAll("#chat-stream .message-row"))
        .filter(r => r.dataset.msgId);
    const index = rows.indexOf(row);
    if (index >= 0) {
        const msg = session.messages[index];
        if (msg) {
            if (!msg.id) msg.id = makeMessageId();
            row.dataset.msgId = msg.id;
            return msg;
        }
    }
    return null;
}

async function copyMessageRow(row) {
    const msg = getMessageByRow(row);
    if (!msg) return;
    const text = msg.role === "image"
        ? (msg.imageData && msg.imageData.original_prompt) || ""
        : (msg.text || "");
    if (!text) {
        showToast("Kopyalanamadı", "Bu mesajda kopyalanacak metin yok.");
        return;
    }

    try {
        let copied = false;

        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(text);
                copied = true;
            } catch (clipErr) {
                copied = false; // izin reddedilirse aşağıdaki yedeğe geç
            }
        }

        if (!copied) {
            const area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            try {
                copied = document.execCommand("copy");
            } catch (execErr) {
                copied = false;
            }
            area.remove();
        }

        if (copied) {
            showToast("Kopyalandı", "Mesaj panoya kopyalandı.");
        } else {
            showToast("Kopyalanamadı", "Tarayıcı pano erişimine izin vermedi.");
        }
    } catch (e) {
        showToast("Kopyalanamadı", "Tarayıcı pano erişimine izin vermedi.");
    }
}

function deleteMessageRow(row) {
    const session = getCurrentSession();
    const msg = getMessageByRow(row);
    if (!session || !msg) return;

    const index = session.messages.findIndex(m => m.id === msg.id);
    if (index < 0) return;

    const [removed] = session.messages.splice(index, 1);
    saveChatSessions();
    renderCurrentSession();

    // Kısa süreli geri alma: yanlışlıkla silmeye karşı güvenli.
    showToast("Mesaj silindi", "Geri almak için bu bildirime dokunun.", () => {
        const target = getCurrentSession();
        if (!target) return;
        target.messages.splice(Math.min(index, target.messages.length), 0, removed);
        saveChatSessions();
        renderCurrentSession();
        showToast("Geri alındı", "Mesaj sohbete geri eklendi.");
    }, 8000);
}

function speakMessageRow(row) {
    const msg = getMessageByRow(row);
    if (!msg || !msg.text) return;
    speakText(String(msg.text).slice(0, 1200));
}

async function regenerateBotMessage(row) {
    const session = getCurrentSession();
    const msg = getMessageByRow(row);
    if (!session || !msg) return;

    if (chatBusy()) {
        showToast("Lumina hâlâ yanıtlıyor", "Mevcut yanıt tamamlanınca yeniden üretebilirsin.");
        return;
    }

    if (msg.role === "image") {
        const data = msg.imageData || {};
        if (!data.original_prompt) return;
        await regenerateImage(
            data.original_prompt,
            data.style || selectedImageStyle,
            data.aspect_ratio || selectedImageRatio
        );
        return;
    }

    if (msg.role !== "bot") {
        showToast("Yeniden üretilemez", "Yalnızca Lumina yanıtları yeniden üretilebilir.");
        return;
    }

    const index = session.messages.findIndex(m => m.id === msg.id);
    let previousUser = null;
    for (let i = index - 1; i >= 0; i--) {
        if (session.messages[i].role === "user" && session.messages[i].text) {
            previousUser = session.messages[i];
            break;
        }
    }
    if (!previousUser) {
        showToast("Yeniden üretilemez", "Bu yanıtın öncesinde bir kullanıcı mesajı bulunamadı.");
        return;
    }

    session.messages.splice(index, 1);
    saveChatSessions();
    renderCurrentSession();
    await sendMessage({
        text: previousUser.text,
        skipUserEcho: true,
        agentMode: msg.agentMode || currentAgentMode
    });
}

function handleMessageAction(action, row) {
    if (!row) return;
    if (action === "copy") copyMessageRow(row);
    else if (action === "regenerate") regenerateBotMessage(row);
    else if (action === "speak") speakMessageRow(row);
    else if (action === "delete") deleteMessageRow(row);
}

function openMessageContextMenu(x, y, row) {
    const menu = document.getElementById("message-context-menu");
    if (!menu || !row) return;
    const msg = getMessageByRow(row);
    if (!msg) return;

    contextMenuRow = row;
    const regenItem = menu.querySelector('[data-context-action="regenerate"]');
    const speakItem = menu.querySelector('[data-context-action="speak"]');
    if (regenItem) regenItem.hidden = !(msg.role === "bot" || msg.role === "image");
    if (speakItem) speakItem.hidden = msg.role !== "bot";

    menu.hidden = false;
    menu.style.visibility = "hidden";
    menu.style.left = "0px";
    menu.style.top = "0px";

    const rect = menu.getBoundingClientRect();
    const pad = 8;
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
    if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
    menu.style.left = Math.max(pad, left) + "px";
    menu.style.top = Math.max(pad, top) + "px";
    menu.style.visibility = "visible";

    const first = menu.querySelector("button:not([hidden])");
    if (first) first.focus({ preventScroll: true });
}

function closeMessageContextMenu() {
    const menu = document.getElementById("message-context-menu");
    if (menu && !menu.hidden) {
        menu.hidden = true;
        menu.style.visibility = "";
    }
    contextMenuRow = null;
}

function setupMessageContextMenu() {
    const stream = document.getElementById("chat-stream");
    const menu = document.getElementById("message-context-menu");
    if (!stream || !menu) return;

    // Masaüstü: sağ tık
    stream.addEventListener("contextmenu", (e) => {
        const row = e.target.closest(".message-row");
        if (!row || !row.dataset.msgId) return;
        e.preventDefault();
        openMessageContextMenu(e.clientX, e.clientY, row);
    });

    // Dokunmatik: basılı tut
    let pressTimer = null;
    let pressStartX = 0;
    let pressStartY = 0;
    let pressedRow = null;
    let longPressFired = false;

    const cancelPress = () => {
        clearTimeout(pressTimer);
        pressTimer = null;
        pressedRow = null;
    };

    stream.addEventListener("touchstart", (e) => {
        const row = e.target.closest(".message-row");
        if (!row || !row.dataset.msgId || e.touches.length !== 1) return;
        pressedRow = row;
        longPressFired = false;
        pressStartX = e.touches[0].clientX;
        pressStartY = e.touches[0].clientY;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
            if (!pressedRow) return;
            longPressFired = true;
            openMessageContextMenu(pressStartX, pressStartY, pressedRow);
            try { if (navigator.vibrate) navigator.vibrate(15); } catch (err) {}
        }, 520);
    }, { passive: true });

    stream.addEventListener("touchmove", (e) => {
        if (!pressedRow || !e.touches.length) return;
        const dx = Math.abs(e.touches[0].clientX - pressStartX);
        const dy = Math.abs(e.touches[0].clientY - pressStartY);
        if (dx > 10 || dy > 10) cancelPress();
    }, { passive: true });

    stream.addEventListener("touchend", (e) => {
        clearTimeout(pressTimer);
        pressTimer = null;
        if (longPressFired) {
            e.preventDefault();
            longPressFired = false;
        }
        pressedRow = null;
    });

    stream.addEventListener("touchcancel", cancelPress);

    // Baloncuk altındaki hızlı eylemler
    stream.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-msg-action]");
        if (!btn) return;
        const row = btn.closest(".message-row");
        if (row) handleMessageAction(btn.dataset.msgAction, row);
    });

    menu.addEventListener("click", (e) => {
        const item = e.target.closest("[data-context-action]");
        if (!item || item.hidden) return;
        const row = contextMenuRow;
        const action = item.dataset.contextAction;
        closeMessageContextMenu();
        handleMessageAction(action, row);
    });

    document.addEventListener("click", (e) => {
        if (!menu.hidden && !menu.contains(e.target)) closeMessageContextMenu();
    }, true);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMessageContextMenu();
    });
    window.addEventListener("scroll", closeMessageContextMenu, true);
    window.addEventListener("resize", closeMessageContextMenu);
}

// ============================================================
// 8. TYPING INDICATOR
// ============================================================

let typingBoxEl = null;

function showTypingIndicator(label = "Lumina düşünüyor...") {
    hideTypingIndicator();
    removeStarterHero();
    const stream = document.getElementById("chat-stream");
    if (!stream) return;

    typingBoxEl = document.createElement("div");
    typingBoxEl.className = "message-row bot-row";
    typingBoxEl.innerHTML = `
        <div class="typing-box">
            <span>${label}</span>
            <div class="typing-dots">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        </div>
    `;
    stream.appendChild(typingBoxEl);
    scrollToBottom();
}

function hideTypingIndicator() {
    if (typingBoxEl && typingBoxEl.parentNode) {
        typingBoxEl.parentNode.removeChild(typingBoxEl);
    }
    typingBoxEl = null;
}

// ============================================================
// 9. CLIENT-SIDE API DIRECT CALLS (GROQ & GITHUB MODELS)
// ============================================================

// Groq üretim model kataloğu (16.10.2026 doğrulandı).
// Eski kimlikler (llama-3.3-70b-versatile, llama-3.1-8b-instant, mixtral-8x7b-32768)
// Groq tarafından kapatıldı ve 404 döndürüyordu — "Groq API Hatası: 404" bunun kaynağıydı.
const DIRECT_MODELS = [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b"
];

const GITHUB_MODELS_URL_NEW = "https://models.github.ai/inference/chat/completions";
const GITHUB_MODELS_URL_LEGACY = "https://models.inference.ai.azure.com/chat/completions";

async function callGitHubEndpoint(token, url, model, messages) {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.65,
            max_tokens: 4096
        })
    });
    if (!res.ok) {
        const err = new Error(`GitHub Models API Hatası: ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    if (data.choices && data.choices.length > 0) {
        return data.choices[0].message.content;
    }
    const err = new Error("GitHub Models API boş yanıt döndürdü.");
    err.status = 502;
    throw err;
}

async function callDirectGitHub(messages, model = "openai/gpt-4o-mini") {
    const token = (directGitHubToken || directGroqKey).trim();
    if (!token) throw new Error("GitHub belirteci yapılandırılmamış.");

    // Birincil uç kuruluş önekli kimlik ister (ör. openai/gpt-4o-mini),
    // eski uç ise öneksiz kimlik bekler. Kapalı model (404) → hemen sonrakine geç.
    const bare = model.split("/").pop();
    const prefixed = model.includes("/") ? model : "openai/" + model;
    const targets = [
        { url: GITHUB_MODELS_URL_NEW, model: prefixed },
        { url: GITHUB_MODELS_URL_LEGACY, model: bare },
        { url: GITHUB_MODELS_URL_NEW, model: "openai/gpt-4o-mini" },
        { url: GITHUB_MODELS_URL_LEGACY, model: "gpt-4o-mini" }
    ];

    let lastErr = null;
    for (const t of targets) {
        try {
            return await callGitHubEndpoint(token, t.url, t.model, messages);
        } catch (e) {
            lastErr = e;
            if (e.status === 401 || e.status === 403) throw e; // yetki hatası: model değişmek çözmez
        }
    }
    throw lastErr || new Error("GitHub Models API yanıt vermedi.");
}

async function callDirectGroqOnce(messages, model) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${directGroqKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.65,
            max_tokens: 4096
        })
    });
    if (!res.ok) {
        const err = new Error(`Groq API Hatası: ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    return data.choices[0].message.content;
}

async function callDirectGroq(messages, model = DIRECT_MODELS[0]) {
    // GitHub PAT belirteci veya Repo Variable algılanırsa doğrudan GitHub Models API'ye git
    const key = (directGroqKey || "").trim();
    if (key.startsWith("ghp_") || key.startsWith("github_pat_") || (!key && directGitHubToken)) {
        return await callDirectGitHub(messages);
    }

    if (!directGroqKey) {
        throw new Error("Groq API veya GitHub belirteci yapılandırılmamış.");
    }

    // İstenen model katalogdaysa onunla başla, değilse kataloğun tamamını sırayla dene.
    const chain = model && model !== DIRECT_MODELS[0]
        ? [model].concat(DIRECT_MODELS.filter(m => m !== model))
        : DIRECT_MODELS.slice();

    let lastErr = null;
    for (const m of chain) {
        try {
            return await callDirectGroqOnce(messages, m);
        } catch (e) {
            lastErr = e;
            if (e.status === 404) continue;              // kapalı/geçersiz model → sıradaki modele geç
            if (e.status) break;                          // 401/403/429/5xx: katalog değişmez, resilient katmanı ele alır
            continue;                                     // ağ hatası: sıradaki model de denensin
        }
    }

    // Groq'da tamamen başarısız olunduysa GitHub Models yedeği
    if (directGitHubToken) {
        try { return await callDirectGitHub(messages); } catch (ge) { lastErr = ge; }
    }
    throw lastErr || new Error("Groq API yanıt vermedi.");
}

// Uygulama arka plana alınınca WebView ağ isteğini kesebilir. Bu sarmalayıcı:
// - ağ hatasında (uygulama arka plandaysa görünür olmasını bekleyip) yeniden dener,
// - 429/5xx durumunda tekrar dener; 404 kaskadı callDirectGroq içinde halledilir.
async function callDirectGroqResilient(messages) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await callDirectGroq(messages);
        } catch (e) {
            lastErr = e;
            // Kalıcı hatalarda (404/401/403 vb.) yeniden denemeye gerek yok
            if (e.status && e.status !== 429 && e.status < 500) throw e;
        }
        if (document.hidden) await waitVisible(60000);
        else await sleep(1000 * (attempt + 1));
    }

    if (directGitHubToken) {
        try { return await callDirectGitHub(messages); } catch (ge) { lastErr = ge; }
    }
    throw lastErr || new Error("Yapay Zeka API'sine ulaşılamadı.");
}

// ============================================================
// 10. SEND MESSAGE CONTROLLER
// ============================================================

async function sendMessage(options = {}) {
    const opts = (options && typeof options === "object") ? options : {};
    const input = document.getElementById("user-input");

    const text = String(opts.text != null ? opts.text : (input ? input.value : "")).trim();
    if (!text) return;

    if (chatBusy()) {
        showToast("Lumina hâlâ yanıtlıyor", "Cevap gelince yeni mesajını gönderebilirsin.");
        return;
    }

    // Yeniden üretmede kullanıcı balonu tekrar basılmaz; metin dışarıdan gelir.
    if (input && opts.text == null) input.value = "";
    rememberFromUserText(text);   // isim gibi bilgiler bu cihazda da (ücretsiz, anında) saklanır
    noteUserActivity(true);
    startKeepAlive();          // kullanıcı hareketi içinde başlatılmalı (ses politikası)
    maybeAskNotifyPermission();

    // Check for image command
    if (text.startsWith("/görsel") || text.toLowerCase().startsWith("görsel oluştur")) {
        const prompt = text.replace(/^\/görsel|^görsel oluştur/i, "").trim();
        if (prompt) {
            if (!opts.skipUserEcho) renderUserMessageElement(text);
            await executeImageGeneration(prompt, selectedImageStyle, selectedImageRatio);
            return;
        }
    }

    if (!opts.skipUserEcho) renderUserMessageElement(text);
    const sid = currentSessionId;
    const agentMode = opts.agentMode || currentAgentMode;

    // Canlı akış tercihi açıkken: yanıtı harf harf akıt (start yazılım ekibinde kullanılmaz)
    if (prefs.streaming && agentMode !== "software" && !text.startsWith("/proje")) {
        const streamed = await tryStreamingSend(text, agentMode, sid);
        if (streamed) return;
    }

    let waitLabel = "Lumina düşünüyor...";
    if (agentMode === "software" || text.startsWith("/proje")) {
        waitLabel = "🚀 Yazılım Ekibi (Mimar → Kodlayıcı → QA) çalışıyor...";
    } else if (agentMode === "math") {
        waitLabel = "📐 Matematik problemi adım adım analiz ediliyor...";
    } else if (agentMode === "research") {
        waitLabel = "🌐 İnternet verileri taranıyor...";
    }

    showTypingIndicator(waitLabel);

    // 1. Backend: arka plan işi (uygulama kapansa bile sunucuda devam eder)
    let backendReached = false;
    if (hasBackend()) {
    try {
        const token = await getAuthToken();
        const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
        const body = JSON.stringify({
            message: text,
            agent_mode: agentMode,
            custom_groq_key: directGroqKey || directGitHubToken || null,
            personality: currentPersonality,
            attached_document: currentAttachedDoc ? {
                filename: currentAttachedDoc.filename,
                excerpt: currentAttachedDoc.excerpt || currentAttachedDoc.preview || ""
            } : null,
            conversation_id: String(currentSessionId || "default").slice(0, 64),
            location: getChatLocationPayload(),
            ...getClientTimeContext()
        });

        let res = await fetch(`${backendUrl}/jobs/chat`, { method: "POST", headers, body });
        backendReached = true;

        if (res.status === 404 || res.status === 405) {
            // Eski backend sürümü: klasik (bekleyen) uca dön
            res = await fetch(`${backendUrl}/chat`, { method: "POST", headers, body });
            const legacy = await res.json().catch(() => ({}));
            handleChatOutcome(sid, agentMode, res.status, legacy);
            return;
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            handleChatOutcome(sid, agentMode, res.status, data);
            return;
        }

        const job = { id: data.job_id, kind: "chat", sid, agentMode, createdAt: Date.now() };
        addPendingJob(job);
        pollJob(job);   // beklemeden arka planda takip edilir
        return;

    } catch (backendError) {
        if (backendReached) {
            deliverBotMessage(sid, "⚠️ Yanıt işlenirken bir hata oluştu. Lütfen tekrar deneyin.", "general");
            stopKeepAliveIfIdle();
            return;
        }
        console.warn("Backend bağlantısı sağlanamadı, sunucusuz mod kontrol ediliyor...", backendError);
    }
    }

    // 2. Sunucusuz mod: doğrudan Groq veya GitHub Models (geçmiş + KALICI HAFIZA + KİŞİLİK ile)
    if (directGroqKey || directGitHubToken) {
        directBusy = true;
        try {
            const mem = loadLocalMemory();

            // "Adım ne?" — isim biliniyorsa modele gitmeden anında ve doğru cevap ver
            if (mem.name && isNameQuestion(text)) {
                directBusy = false;
                handleChatOutcome(sid, agentMode, 200, { reply: pickNameAnswer(mem.name), agent_mode: agentMode });
                return;
            }

            let basePrompt = agentMode === "math"
                ? "Sen üstün matematik ajanısın. Problemleri adım adım çöz, formülleri LaTeX formatında ($) yaz."
                : "Sen Lumina AI'sın. Empatik, samimi, zeki ve yaşayan bir insan sıcaklığında konuş. Seni kim yaptı diye sorulursa 'LuminaStudios'un kurucusu Arel.' de.";

            const personalityInstruction = PERSONALITY_DESCRIPTIONS[currentPersonality]?.instruction;
            if (personalityInstruction) {
                basePrompt += `\n\n${personalityInstruction}`;
            }

            const memBlock = buildLocalMemoryBlock(mem);
            const sysPrompt = memBlock ? `${basePrompt}\n\n${memBlock}` : basePrompt;

            const directReply = await callDirectGroqResilient([
                { role: "system", content: sysPrompt },
                ...buildDirectHistory(sid, 24)
            ]);
            directBusy = false;
            handleChatOutcome(sid, agentMode, 200, { reply: directReply, agent_mode: agentMode });
            extractFactsClient(text, directReply).catch(() => {});   // arka planda, sohbeti bloklamaz
        } catch (groqErr) {
            directBusy = false;
            deliverBotMessage(sid, `⚠️ Yapay Zeka API Hatası: ${groqErr.message}`, "general");
            stopKeepAliveIfIdle();
        }
        return;
    }

    // 3. Ne backend ne de Groq/GitHub anahtarı var
    deliverBotMessage(
        sid,
        "⚠️ **Bağlantı Uyarısı:**\n\n" +
        "Yerel Python backend sunucusuna bağlanılamadı.\n\n" +
        "• **Kendi bilgisayarınızda çalıştırıyorsanız:** `baslat.bat` dosyasını çalıştırarak `python main.py` sunucusunu açın.\n" +
        "• **GitHub Pages / APK olarak sunucusuz kullanmak istiyorsanız:** Sol alttaki ⚙️ **Ayarlar** simgesine tıklayıp kendi **Groq API Anahtarınızı** veya **GitHub Belirtecinizi (Variable)** girin.",
        "general"
    );
    stopKeepAliveIfIdle();
}

// ============================================================
// 11. IMAGE GENERATION WORKFLOW
// ============================================================

function openImageStudioModal() {
    const modal = document.getElementById("image-modal");
    if (modal) {
        modal.style.display = "flex";
        const input = document.getElementById("image-prompt-input");
        if (input) input.focus();
    }
}

function closeImageStudioModal() {
    const modal = document.getElementById("image-modal");
    if (modal) modal.style.display = "none";
}

function selectImageStyle(style) {
    selectedImageStyle = style;
    document.querySelectorAll("#style-selector .choice-pill").forEach(p => {
        p.classList.toggle("active", p.getAttribute("data-style") === style);
    });
}

function selectImageRatio(ratio) {
    selectedImageRatio = ratio;
    document.querySelectorAll("#ratio-selector .choice-pill").forEach(p => {
        p.classList.toggle("active", p.getAttribute("data-ratio") === ratio);
    });
}

async function regenerateImage(prompt, style, ratio) {
    if (!prompt) return;
    renderUserMessageElement(`🔄 Yeniden Oluştur: "${prompt}"`);
    await executeImageGeneration(prompt, style, ratio);
}

async function submitImageGeneration() {
    const input = document.getElementById("image-prompt-input");
    const prompt = input ? input.value.trim() : "";
    if (!prompt) {
        alert("Lütfen bir görsel açıklaması girin.");
        return;
    }
    closeImageStudioModal();
    input.value = "";
    renderUserMessageElement(`🎨 Görsel İsteği: "${prompt}" [Tarz: ${selectedImageStyle}, Oran: ${selectedImageRatio}]`);
    await executeImageGeneration(prompt, selectedImageStyle, selectedImageRatio);
}

// ---- Yerel (client-side) hızlı güvenlik ön-filtresi -------------------
// ÖNEMLİ: Bu SADECE backend'e hiç ulaşılamadığı (gerçek ağ hatası / sunucu
// kapalı) durumda devreye giren client-side Pollinations yedeğini korumak
// içindir. Backend her zaman öncelikli ve asıl moderasyon katmanı orasıdır
// (main.py -> check_image_safety, hem regex hem LLM tabanlı). Bu client-side
// liste sadece "sunucu tamamen erişilemezken bile en azından bariz +18/şiddet
// isteklerini engelle" amaçlı, ikincil ve daha zayıf bir emniyet kemeridir.
const CLIENT_SIDE_UNSAFE_PATTERN = /(nsfw|porno|pornograf|nude|nudity|naked|topless|çıplak|soyun|adult\s*content|hentai|erotik|erotic|seks\b|sex\b|sexual|sik\b|sikiş|onlyfans|boudoir|lingerie|fetish|bdsm|explicit|katliam|öldür|cinayet|işkence|intihar|gore|mutilat|beheading|bomba yap|patlayıcı|tecavüz|taciz|rape\b|child.{0,25}(nude|naked|sex)|naked.{0,25}(child|minor))/i;

function clientSideSafetyCheck(text) {
    return !CLIENT_SIDE_UNSAFE_PATTERN.test(text);
}

async function executeImageGeneration(prompt, style, ratio) {
    const sid = currentSessionId;
    showTypingIndicator("🎨 Prompt zenginleştiriliyor ve ultra gerçekçi görsel oluşturuluyor...");
    startKeepAlive();

    // Backend önce denenir — gerçek moderasyon (regex + LLM) yalnızca orada.
    let backendReached = false;
    if (hasBackend()) {
    try {
        const token = await getAuthToken();
        const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
        const body = JSON.stringify({
            prompt: prompt,
            style: style,
            aspect_ratio: ratio,
            custom_groq_key: directGroqKey || null
        });

        let res = await fetch(`${backendUrl}/jobs/image`, { method: "POST", headers, body });
        backendReached = true; // sunucudan yanıt aldık — client-side yedeğe DÜŞMEMELİYİZ

        if (res.status === 404 || res.status === 405) {
            res = await fetch(`${backendUrl}/generate-image`, { method: "POST", headers, body });
            const legacy = await res.json().catch(() => ({}));
            await handleImageOutcome(sid, res.status, legacy);
            return;
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            await handleImageOutcome(sid, res.status, data);
            return;
        }

        const job = { id: data.job_id, kind: "image", sid, prompt, style, ratio, createdAt: Date.now() };
        addPendingJob(job);
        pollJob(job);
        return;

    } catch (e) {
        if (backendReached) {
            // Yanıt geldi ama işlenirken hata oluştu — güvenlik nedeniyle filtresiz yedeğe düşmüyoruz.
            deliverBotMessage(sid, "⚠️ Görsel oluşturulurken bir hata oluştu. Lütfen tekrar deneyin.", "artist");
            stopKeepAliveIfIdle();
            return;
        }
        console.warn("Backend görsel sunucusuna ulaşılamadı (gerçek ağ hatası), sınırlı client-side yedek deneniyor...", e);
    }
    }

    // Buraya SADECE backend'e hiç ulaşılamadığında düşülür. LLM moderasyonu yok,
    // bu yüzden önce zayıf ama anlık bir anahtar kelime kontrolü uygulanır.
    if (!clientSideSafetyCheck(prompt)) {
        deliverBotMessage(
            sid,
            "⛔ Bu isteği reddediyorum. Lumina AI; +18 içerik, şiddet veya güvenlik dışı taleplere yardımcı olamaz.\n\n" +
            "(Not: Backend sunucusuna ulaşılamadığı için sınırlı client-side filtre devrede. Tam moderasyon için backend'in çalışıyor olması gerekir.)",
            "artist"
        );
        stopKeepAliveIfIdle();
        return;
    }

    const dimMap = { "1:1": [1024, 1024], "16:9": [1280, 720], "9:16": [720, 1280] };
    const [w, h] = dimMap[ratio] || [1024, 1024];
    const seed = Math.floor(Math.random() * 900000) + 10000;
    const encoded = encodeURIComponent(`${prompt}, ${style}, 8k uhd, ultra photorealistic, hyper-detailed skin texture, natural lighting, sharp focus, no plastic look`);
    const fallbackUrl = `https://image.pollinations.ai/prompt/${encoded}?width=${w}&height=${h}&model=flux-realism&seed=${seed}&nologo=true&safe=true`;

    await presentGeneratedImage(sid, {
        image_url: fallbackUrl,
        original_prompt: prompt,
        enhanced_prompt: prompt,
        style: style,
        aspect_ratio: ratio,
        seed: seed
    });
}

// Lightbox
function openLightbox(src) {
    const modal = document.getElementById("lightbox-modal");
    const img = document.getElementById("lightbox-img");
    if (modal && img) {
        img.src = src;
        modal.style.display = "flex";
    }
}

function closeLightbox() {
    const modal = document.getElementById("lightbox-modal");
    if (modal) modal.style.display = "none";
}

// ============================================================
// 12. SETTINGS & AUTH MODALS
// ============================================================

function openSettingsModal() {
    const modal = document.getElementById("settings-modal");
    if (modal) {
        const urlInput = document.getElementById("setting-backend-url");
        const keyInput = document.getElementById("setting-groq-key");
        const gitInput = document.getElementById("setting-github-token");

        if (urlInput) urlInput.value = backendUrl;
        if (keyInput) keyInput.value = directGroqKey;
        if (gitInput) gitInput.value = directGitHubToken;

        // Kişilik aktif kartını işaretle
        document.querySelectorAll(".personality-card").forEach(el => {
            el.classList.toggle("active", el.dataset.personality === currentPersonality);
        });

        // Ses aktif kartını işaretle
        document.querySelectorAll(".voice-card").forEach(el => {
            el.classList.toggle("active", el.dataset.voice === currentSelectedVoice);
        });

        // Renk paleti aktif daire ve değerini güncelle
        applyAccentColor(currentAccentColor);

        // Mod ortam müziği UI güncelle
        if (window.LuminaModeAudioEngine) {
            window.LuminaModeAudioEngine.updateUI();
        }

        // GitHub Değişkeni / Variable durumu kontrolü
        const gitStatus = document.getElementById("github-var-status");
        if (gitStatus) {
            const hasAutoConfig = Boolean(
                (window.LUMINA_CONFIG && (window.LUMINA_CONFIG.GROQ_API_KEY || window.LUMINA_CONFIG.GITHUB_TOKEN)) ||
                (window.ENV && (window.ENV.GROQ_API_KEY || window.ENV.GITHUB_TOKEN))
            );
            if (hasAutoConfig) {
                gitStatus.innerHTML = `<span style="color:#10b981; font-weight:600;">✓ config.js / GitHub Variable algılandı ve devrede.</span>`;
            } else if (directGitHubToken) {
                gitStatus.innerHTML = `<span style="color:#3b82f6; font-weight:600;">✓ GitHub Token (PAT) aktif.</span>`;
            } else {
                gitStatus.innerHTML = `<span style="color:var(--text-muted);">Ortam değişkeni tanımlanmadıysa yukarıya belirtecinizi yapıştırabilirsiniz.</span>`;
            }
        }

        modal.style.display = "flex";
        refreshPrefsUI();
        fetchAndDisplayMemory();
        updateAccountStatusPhone();
    }
}

function closeSettingsModal() {
    const modal = document.getElementById("settings-modal");
    if (modal) modal.style.display = "none";
}

function saveSettings() {
    const urlInput = document.getElementById("setting-backend-url");
    const keyInput = document.getElementById("setting-groq-key");
    const gitInput = document.getElementById("setting-github-token");

    if (urlInput) {
        const raw = urlInput.value.trim();
        const sanitized = sanitizeBackendUrl(raw);
        if (raw && !sanitized) {
            showToast(
                "Geçersiz Backend Adresi",
                "Üretimde yalnızca HTTPS adresleri kabul edilir; localhost ve http:// reddedilir.",
                null,
                9000
            );
            return;
        }
        backendUrl = sanitized || resolveDefaultBackendUrl();
        if (backendUrl) localStorage.setItem("lumina_backend_url", backendUrl);
        else localStorage.removeItem("lumina_backend_url");
    }
    if (keyInput) {
        directGroqKey = keyInput.value.trim();
        localStorage.setItem("lumina_direct_groq_key", directGroqKey);
    }
    if (gitInput) {
        directGitHubToken = gitInput.value.trim();
        localStorage.setItem("lumina_github_token", directGitHubToken);
    }

    localStorage.setItem("lumina_personality", currentPersonality);
    localStorage.setItem("lumina_selected_voice", currentSelectedVoice);
    localStorage.setItem("lumina_accent_color", currentAccentColor);

    closeSettingsModal();
    showToast("Ayarlar kaydedildi", "Kişilik, ses ve tema ayarlarınız uygulandı.");
}

// ============================================================
// GİRİŞ / KAYIT AKIŞI
// ============================================================

function openAuthModal(options = {}) {
    const modal = document.getElementById("auth-modal");
    if (!modal) return;

    isAuthGate = Boolean(options.gate);
    showAuthChoice();
    modal.style.display = "flex";

    if (options.provider === "google") {
        handleGoogleLogin();
    } else if (options.provider === "email") {
        showEmailForm(options.mode === "register" ? "register" : "login");
    }
}

function closeAuthModal() {
    const modal = document.getElementById("auth-modal");
    if (modal) modal.style.display = "none";
    isAuthGate = false;
    clearAuthError();
}

function dismissAuthGate() {
    // İlk ziyaret kapısında kapatma, kullanıcıyı kilitlemek yerine misafir moduna geçirir.
    if (isAuthGate) {
        continueAsGuest();
        return;
    }
    closeAuthModal();
}

function showAuthChoice() {
    const choice = document.getElementById("auth-panel-choice");
    const email = document.getElementById("auth-panel-email");
    if (choice) choice.classList.add("active");
    if (email) email.classList.remove("active");
    clearAuthError();
}

function showEmailForm(mode) {
    emailAuthMode = mode === "register" ? "register" : "login";
    const choice = document.getElementById("auth-panel-choice");
    const emailPanel = document.getElementById("auth-panel-email");
    if (choice) choice.classList.remove("active");
    if (emailPanel) emailPanel.classList.add("active");

    const isRegister = emailAuthMode === "register";
    const title = document.getElementById("auth-form-title");
    const subtitle = document.getElementById("auth-form-subtitle");
    const submit = document.getElementById("auth-submit-btn");
    const switchText = document.getElementById("auth-switch-text");
    const switchBtn = document.getElementById("auth-switch-btn");
    const passInput = document.getElementById("auth-password");

    if (title) title.innerText = isRegister ? "Yeni Hesap Oluştur" : "E-posta ile Giriş";
    if (subtitle) subtitle.innerText = isRegister
        ? "Birkaç saniyede hesabını oluştur ve sohbetlerini güvenceye al."
        : "Hesabına giriş yaparak kaldığın yerden devam et.";
    if (submit) submit.innerText = isRegister ? "Kayıt Ol" : "Giriş Yap";
    if (switchText) switchText.innerText = isRegister ? "Zaten hesabın var mı?" : "Hesabın yok mu?";
    if (switchBtn) switchBtn.innerText = isRegister ? "Giriş Yap" : "Kayıt Ol";
    if (passInput) passInput.autocomplete = isRegister ? "new-password" : "current-password";

    clearAuthError();
    const emailInput = document.getElementById("auth-email");
    if (emailInput) setTimeout(() => emailInput.focus(), 60);
}

function toggleEmailMode() {
    showEmailForm(emailAuthMode === "register" ? "login" : "register");
}

function clearAuthError() {
    const box = document.getElementById("auth-error");
    if (!box) return;
    box.innerText = "";
    box.classList.remove("visible");
}

function setAuthError(message) {
    const box = document.getElementById("auth-error");
    if (!box) {
        showToast("İşlem Başarısız", message);
        return;
    }
    box.innerText = message;
    box.classList.add("visible");
}

function finishAuthSuccess(title, message) {
    markWelcomeSeen();
    closeAuthModal();
    showToast(title, message);
    fetchSubscriptionDetails();
}

function continueAsGuest() {
    markWelcomeSeen();
    isGuestMode = true;
    currentUser = null;
    updateUserDisplay("Misafir Modu");
    closeAuthModal();
    showToast("Misafir Modu", "Lumina AI'ı temel kotalarla misafir olarak kullanıyorsunuz.");
}

function translateAuthError(err) {
    if (!err) return "Bilinmeyen bir kimlik doğrulama hatası oluştu.";
    const code = err.code || "";
    switch (code) {
        case "auth/invalid-email":
            return "Geçersiz e-posta adresi formatı. Lütfen kontrol edin.";
        case "auth/user-disabled":
            return "Bu kullanıcı hesabı devre dışı bırakılmış.";
        case "auth/user-not-found":
            return "Bu e-posta adresiyle kayıtlı bir hesap bulunamadı.";
        case "auth/wrong-password":
            return "Hatalı şifre girdiniz. Lütfen tekrar deneyin.";
        case "auth/invalid-credential":
        case "auth/invalid-login-credentials":
            return "E-posta veya şifre hatalı. Lütfen kontrol edip tekrar deneyin.";
        case "auth/missing-password":
            return "Lütfen şifrenizi girin.";
        case "auth/email-already-in-use":
            return "Bu e-posta adresi zaten kullanımda. Giriş yapmayı deneyebilirsiniz.";
        case "auth/weak-password":
            return "Şifreniz çok zayıf. Güvenliğiniz için en az 6 karakter olmalıdır.";
        case "auth/network-request-failed":
            return "Ağ bağlantısı kurulamadı. İnternet bağlantınızı kontrol edin.";
        case "auth/popup-closed-by-user":
            return "Google ile giriş penceresi kapatıldı. Tekrar deneyebilirsiniz.";
        case "auth/popup-blocked":
            return "Google giriş penceresi tarayıcı tarafından engellendi. Açılır pencerelere izin verin.";
        case "auth/cancelled-popup-request":
            return "Google giriş isteği iptal edildi. Lütfen tekrar deneyin.";
        case "auth/operation-not-supported-in-this-environment":
            return "Bu ortamda açılır pencere ile giriş desteklenmiyor. Yönlendirme yöntemi denenecek.";
        case "auth/unauthorized-domain":
            return "Bu alan adı Firebase Console'da yetkili alan adları listesine eklenmemiş. " +
                   "Google ile giriş için http://localhost:5500 adresini kullanın ve Firebase Console → Authentication → Settings → Authorized domains bölümüne ekleyin.";
        case "auth/account-exists-with-different-credential":
            return "Bu e-posta adresi farklı bir giriş yöntemiyle kayıtlı. Lütfen e-posta ile giriş yapın.";
        case "auth/credential-already-in-use":
            return "Bu Google hesabı başka bir Lumina hesabına bağlı.";
        case "auth/missing-or-invalid-nonce":
            return "Giriş doğrulaması tamamlanamadı. Sayfayı yenileyip tekrar deneyin.";
        case "auth/internal-error":
            return "Kimlik doğrulama servisinde geçici bir hata oluştu. Lütfen tekrar deneyin.";
        case "auth/operation-not-allowed":
            return "Bu giriş yöntemi şu anda etkin değil. Firebase Console'da Google sağlayıcısını etkinleştirin veya farklı bir yöntem deneyin.";
        case "auth/too-many-requests":
            return "Çok fazla başarısız deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin.";
        default:
            return err.message || "Kimlik doğrulama işlemi sırasında bir hata oluştu.";
    }
}

function readEmailForm() {
    const emailInput = document.getElementById("auth-email");
    const passInput = document.getElementById("auth-password");
    return {
        email: emailInput ? emailInput.value.trim() : "",
        pass: passInput ? passInput.value : ""
    };
}

async function submitEmailAuth() {
    if (emailAuthMode === "register") {
        await handleEmailRegister();
    } else {
        await handleEmailLogin();
    }
}

async function handleEmailLogin() {
    if (!isFirebaseActive) { continueAsGuest(); return; }
    const { email, pass } = readEmailForm();
    if (!email || !pass) {
        setAuthError("Lütfen e-posta ve şifrenizi girin.");
        return;
    }

    const submit = document.getElementById("auth-submit-btn");
    if (submit) submit.disabled = true;
    clearAuthError();
    try {
        const cred = await auth.signInWithEmailAndPassword(email, pass);
        finishAuthSuccess("Giriş Başarılı", `Hoş geldiniz, ${cred.user.displayName || cred.user.email}!`);
    } catch (e) {
        setAuthError(translateAuthError(e));
    } finally {
        if (submit) submit.disabled = false;
    }
}

async function handleEmailRegister() {
    if (!isFirebaseActive) { continueAsGuest(); return; }
    const { email, pass } = readEmailForm();
    if (!email || !pass) {
        setAuthError("Lütfen e-posta ve şifrenizi girin.");
        return;
    }
    if (pass.length < 6) {
        setAuthError("Şifreniz en az 6 karakter olmalıdır.");
        return;
    }

    const submit = document.getElementById("auth-submit-btn");
    if (submit) submit.disabled = true;
    clearAuthError();
    try {
        await auth.createUserWithEmailAndPassword(email, pass);
        finishAuthSuccess("Kayıt Başarılı", "Hesabınız başarıyla oluşturuldu.");
    } catch (e) {
        setAuthError(translateAuthError(e));
    } finally {
        if (submit) submit.disabled = false;
    }
}

async function handleGoogleLogin() {
    if (!isFirebaseActive || !googleProvider) { continueAsGuest(); return; }

    clearAuthError();

    if (window.location.protocol === "file:") {
        setAuthError(
            "Google ile giriş dosya (file://) üzerinden çalışmaz. " +
            "Lütfen projeyi http://localhost:5500 adresinden açın."
        );
        return;
    }

    if (window.location.hostname === "127.0.0.1") {
        showToast(
            "Adres Önerisi",
            "Google girişi için http://localhost:5500 adresini kullanmanız önerilir. 127.0.0.1 Firebase'de yetkili alan adı olmayabilir."
        );
    }

    const googleBtn = document.querySelector('.auth-option-btn.google');
    if (googleBtn) googleBtn.disabled = true;

    try {
        const cred = await auth.signInWithPopup(googleProvider);
        finishAuthSuccess("Google Girişi", `Hoş geldiniz, ${cred.user.displayName || cred.user.email}!`);
    } catch (e) {
        const code = (e && e.code) || "";

        // Popup engellendiği veya bu ortamda desteklenmediği durumda yönlendirmeye geç.
        const redirectFallbackCodes = [
            "auth/popup-blocked",
            "auth/operation-not-supported-in-this-environment",
            "auth/cancelled-popup-request"
        ];

        if (redirectFallbackCodes.includes(code)) {
            try {
                // Oturum bilgisi sayfa yenilenince korunur; redirect sonucu açılışta okunur.
                if (auth.setPersistence && firebase.auth.Auth.Persistence) {
                    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
                }
                await auth.signInWithRedirect(googleProvider);
                return;
            } catch (re) {
                setAuthError(translateAuthError(re));
                return;
            }
        }

        setAuthError(translateAuthError(e));
    } finally {
        if (googleBtn) googleBtn.disabled = false;
    }
}

// Yönlendirme (redirect) ile dönen Google girişini tamamlar.
function handleAuthRedirectResult() {
    if (!isFirebaseActive || !auth || typeof auth.getRedirectResult !== "function") return;
    auth.getRedirectResult()
        .then((result) => {
            if (result && result.user) {
                finishAuthSuccess(
                    "Google Girişi",
                    `Hoş geldiniz, ${result.user.displayName || result.user.email}!`
                );
            }
        })
        .catch((err) => {
            const code = (err && err.code) || "";
            if (code && code !== "auth/no-auth-event") {
                setAuthError(translateAuthError(err));
            }
        });
}

async function handleLogout() {
    if (isFirebaseActive && auth) {
        try {
            await auth.signOut();
            currentUser = null;
            isGuestMode = true;
            updateUserDisplay("Misafir Modu");
            showToast("Çıkış Yapıldı", "Oturumunuz güvenle sonlandırıldı.");
            fetchAndDisplayQuota();
        } catch (e) {
            console.error("Çıkış hatası:", e);
        }
    } else {
        continueAsGuest();
    }
}

// ============================================================
// 13. SPEECH TO TEXT, TTS & LIVE VOICE MODE (VOICE ORB)
// ============================================================

let isVoiceModeActive = false;
let voiceModeMuted = false;
let isVoiceModeProcessing = false;
let liveVoiceRecognition = null;
let voiceSilenceTimer = null;

function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.lang = "tr-TR";
        recognition.continuous = false;
        recognition.interimResults = false;

        recognition.onstart = () => {
            isRecording = true;
            const btn = document.getElementById("mic-btn");
            if (btn) btn.classList.add("active");
        };

        recognition.onresult = (e) => {
            const transcript = e.results[0][0].transcript;
            const input = document.getElementById("user-input");
            if (input) {
                input.value = transcript;
                sendMessage();
            }
        };

        recognition.onerror = () => stopRecording();
        recognition.onend = () => stopRecording();
    }
}

function toggleVoiceInput() {
    // Mikrofon butonuna basıldığında görseldeki canlı sesli daire modunu aç
    openLiveVoiceMode();
}

function stopRecording() {
    isRecording = false;
    const btn = document.getElementById("mic-btn");
    if (btn) btn.classList.remove("active");
}

function toggleSpeechOutput() {
    voiceEnabled = !voiceEnabled;
    const btn = document.getElementById("tts-btn");
    if (btn) {
        btn.innerText = voiceEnabled ? "🔊" : "🔇";
    }
    if (!voiceEnabled && window.LuminaVoice) {
        window.LuminaVoice.stop();
    }
}

// Metin içerisindeki tüm emojileri, kod bloklarını ve seslendirilmemesi gereken sembolleri temizler.
// Böylece tarayıcı "gözlük adam emojisi", "gülen yüz", "parıltı" gibi Unicode açıklamalarını KESİNLİKLE SESLENDİRMEZ.
function cleanTextForSpeech(text) {
    if (!text) return "";
    return text
        // Markdown kod blokları ve formüller
        .replace(/```[\s\S]*?```/g, "Kod bloğu.")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\$\$[\s\S]*?\$\$/g, "Matematik formülü.")
        .replace(/\$[^$]*\$/g, "")
        // HTML etiketleri ve linkler
        .replace(/<[^>]*>/g, "")
        .replace(/https?:\/\/\S+/gi, "web bağlantısı")
        // TÜM UNICODE EMOJİLER VE ÖZEL PİKTOGRAF ARALIKLARI (Böylece hiçbir emoji adı okunmaz)
        .replace(/[\u{1F300}-\u{1FAD6}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{200C}]/gu, "")
        // Tipografik semboller, işaretler ve parantezler
        .replace(/[*_#~>\[\]\(\)\{\}\\|]/g, " ")
        .replace(/[•●★☆✔✓✕✖✗©®™—–]/g, " ")
        // Metin içi gülen suratlar :) :( :D vs.
        .replace(/[:;=8]-?[)D(\/\\pP3*]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

// ------------------------------------------------------------
// ESKİ SES SEÇİCİ — KALDIRILDI
// ------------------------------------------------------------
// Önceki sürüm, cihazdaki TEK Türkçe sesi tüm profillere bağlıyor ve
// ardından pitch değerini değiştirerek "farklı konuşmacı" izlenimi
// veriyordu. Bu davranış tamamen kaldırıldı.
//
// Gerçek ses ataması `voice_engine.js` içindeki
// `assignUniqueBrowserVoices()` tarafından yapılır: her profile farklı bir
// voiceURI atanır, pitch DAİMA 1.0'dır ve yeterli benzersiz ses yoksa
// profil "kullanılamıyor" olarak raporlanır.
function findBestVoiceForProfile(profile) {
    if (profile && profile.gender) {
        console.info(
            "findBestVoiceForProfile kullanımdan kaldırıldı; ses seçimi LuminaVoice tarafından yapılır."
        );
    }
    return { voice: null, isFemaleVoice: Boolean(profile && profile.gender === "female") };
}

function speakText(text, opts = {}) {
    if (!voiceEnabled && !opts.force) return;

    if (!window.LuminaVoice) {
        const err = new Error(
            "Ses motoru (voice_engine.js) yüklenmedi. Ses üretilemiyor. Sayfayı yenileyin."
        );
        if (opts.onError) opts.onError(err);
        return;
    }

    const voiceKey = opts.voiceKey || currentSelectedVoice ||
        (currentPersonality === "girly" ? "jenna" : currentPersonality === "boys" ? "tommy" : "jenna");

    const result = window.LuminaVoice.speak(text, {
        ...voiceCallbacks(opts),
        profileId: voiceKey,
        force: opts.force === true
    });

    if (result && typeof result.catch === "function") {
        result.catch((err) => {
            if (opts.onError) opts.onError(err);
        });
    }
}

// -------------------------------------------------------------
// CANLI SESLİ SOHBET MODU (VOICE ORB CONTROLLER - GÖRSELDEKİ BİREBİR YAPI)
// -------------------------------------------------------------

function setupLiveVoiceRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    liveVoiceRecognition = new SpeechRecognition();
    liveVoiceRecognition.lang = "tr-TR";
    liveVoiceRecognition.continuous = true;
    liveVoiceRecognition.interimResults = true;

    let accumulatedText = "";

    liveVoiceRecognition.onstart = () => {
        if (!isVoiceModeActive) return;
        updateVoiceOrbState("listening", "Dinliyor...");
    };

    liveVoiceRecognition.onresult = (e) => {
        if (!isVoiceModeActive || voiceModeMuted || isVoiceModeProcessing) return;

        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const part = e.results[i][0].transcript;
            if (e.results[i].isFinal) {
                accumulatedText += " " + part;
            } else {
                interim += part;
            }
        }

        const currentSaid = (accumulatedText + " " + interim).trim();
        const box = document.getElementById("voice-transcript-box");
        if (box && currentSaid) {
            box.textContent = "Sen: " + currentSaid;
        }

        // Sessizlik algılama: kullanıcı 1.2 saniye susarsa otomatik Lumina'ya sor
        clearTimeout(voiceSilenceTimer);
        if (currentSaid.length >= 2) {
            voiceSilenceTimer = setTimeout(() => {
                const toSend = currentSaid;
                accumulatedText = "";
                processVoiceModeInput(toSend);
            }, 1200);
        }
    };

    liveVoiceRecognition.onerror = (err) => {
        if (!isVoiceModeActive) return;
        console.warn("Canlı ses tanıma durumu:", err.error);
    };

    liveVoiceRecognition.onend = () => {
        // Ses modu açıksa ve işlemde değilse kesintisiz dinlemeyi sürdür
        if (isVoiceModeActive && !voiceModeMuted && !isVoiceModeProcessing) {
            try { liveVoiceRecognition.start(); } catch (e) {}
        }
    };
}

function openLiveVoiceMode() {
    isVoiceModeActive = true;
    voiceModeMuted = false;
    isVoiceModeProcessing = false;

    if (window.LuminaModeAudioEngine) {
        window.LuminaModeAudioEngine.onVoiceStart();
    }

    const modal = document.getElementById("voice-mode-modal");
    if (modal) modal.style.display = "flex";

    const box = document.getElementById("voice-transcript-box");
    if (box) box.textContent = "Konuşmaya başlayın... Lumina sizi dinliyor.";

    const micBtn = document.getElementById("voice-mic-round-btn");
    if (micBtn) micBtn.classList.remove("muted");

    updateVoiceOrbState("listening", "Dinliyor...");

    if (!liveVoiceRecognition) setupLiveVoiceRecognition();

    try {
        if (liveVoiceRecognition) liveVoiceRecognition.start();
    } catch (e) {}
}

function closeLiveVoiceMode() {
    isVoiceModeActive = false;
    isVoiceModeProcessing = false;
    clearTimeout(voiceSilenceTimer);

    if (window.LuminaModeAudioEngine) {
        window.LuminaModeAudioEngine.onVoiceEnd();
    }

    if (liveVoiceRecognition) {
        try { liveVoiceRecognition.stop(); } catch (e) {}
    }
    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }

    const modal = document.getElementById("voice-mode-modal");
    if (modal) modal.style.display = "none";
}

function toggleVoiceModeMic() {
    voiceModeMuted = !voiceModeMuted;
    const micBtn = document.getElementById("voice-mic-round-btn");

    if (voiceModeMuted) {
        if (micBtn) micBtn.classList.add("muted");
        if (liveVoiceRecognition) try { liveVoiceRecognition.stop(); } catch (e) {}
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        updateVoiceOrbState("idle", "Mikrofon Kapalı");
    } else {
        if (micBtn) micBtn.classList.remove("muted");
        updateVoiceOrbState("listening", "Dinliyor...");
        if (liveVoiceRecognition) try { liveVoiceRecognition.start(); } catch (e) {}
    }
}

function switchToTextInputFromVoice() {
    closeLiveVoiceMode();
    const input = document.getElementById("user-input");
    if (input) input.focus();
}

function updateVoiceOrbState(state, label) {
    const wrapper = document.getElementById("voice-orb-wrapper");
    const statusText = document.getElementById("voice-status-text");
    const statusIcon = document.getElementById("voice-status-icon");

    if (wrapper) {
        wrapper.classList.remove("listening", "thinking", "speaking", "idle");
        wrapper.classList.add(state);
    }
    if (statusText) statusText.textContent = label;
    if (statusIcon) {
        if (state === "listening") statusIcon.textContent = "🟢";
        else if (state === "thinking") statusIcon.textContent = "⚡";
        else if (state === "speaking") statusIcon.textContent = "🔊";
        else statusIcon.textContent = "⚪";
    }
}

async function processVoiceModeInput(text) {
    if (!text || !text.trim()) return;

    isVoiceModeProcessing = true;
    clearTimeout(voiceSilenceTimer);

    if (liveVoiceRecognition) {
        try { liveVoiceRecognition.stop(); } catch (e) {}
    }

    updateVoiceOrbState("thinking", "Düşünüyor...");

    rememberFromUserText(text);
    noteUserActivity(true);

    const sid = currentSessionId;
    renderUserMessageElement(text);

    // İsim sorusu kontrolü
    const mem = loadLocalMemory();
    if (mem.name && isNameQuestion(text)) {
        const nameAns = pickNameAnswer(mem.name);
        handleVoiceOutcome(sid, nameAns);
        return;
    }

    // 1. Önce Backend'i dene (yalnızca gerçek backend varsa)
    let backendSuccess = false;
    if (hasBackend()) {
    try {
        const token = await getAuthToken();
        const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
        const body = JSON.stringify({
            message: text,
            agent_mode: "general",
            custom_groq_key: directGroqKey || directGitHubToken || null,
            personality: currentPersonality,
            location: getChatLocationPayload(),
            ...getClientTimeContext()
        });

        const res = await fetch(`${backendUrl}/chat`, { method: "POST", headers, body });
        if (res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data.reply) {
                backendSuccess = true;
                handleVoiceOutcome(sid, data.reply);
                return;
            }
        }
    } catch (e) {
        console.warn("Backend çağrısı başarısız, doğrudan yapay zeka motoruna geçiliyor...", e);
    }
    }

    // 2. Doğrudan Groq veya GitHub Models API çağrısı
    if (directGroqKey || directGitHubToken) {
        try {
            let basePrompt = "Sen Lumina AI'sın. Empatik, samimi, zeki ve yaşayan bir insan sıcaklığında konuş. Seni kim yaptı diye sorulursa 'LuminaStudios'un kurucusu Arel.' de. Canlı sesli sohbette olduğun için yanıtlarını doğal, akıcı, konuşma diline uygun ve dinlenebilir tut.";
            const personalityInstruction = PERSONALITY_DESCRIPTIONS[currentPersonality]?.instruction;
            if (personalityInstruction) {
                basePrompt += `\n\n${personalityInstruction}`;
            }

            const memBlock = buildLocalMemoryBlock(mem);
            const sysPrompt = memBlock ? `${basePrompt}\n\n${memBlock}` : basePrompt;

            const reply = await callDirectGroqResilient([
                { role: "system", content: sysPrompt },
                ...buildDirectHistory(sid, 12),
                { role: "user", content: text }
            ]);

            handleVoiceOutcome(sid, reply);
            extractFactsClient(text, reply).catch(() => {});
            return;
        } catch (err) {
            handleVoiceOutcome(sid, `Üzgünüm, yanıt üretilirken bir hata oluştu: ${err.message}`);
            return;
        }
    }

    handleVoiceOutcome(
        sid,
        "Yapay zeka anahtarı tanımlanmamış. Lütfen sağ üstteki ayarlar simgesinden Groq API anahtarınızı veya GitHub belirtecinizi girin."
    );
}

function handleVoiceOutcome(sid, replyText) {
    deliverBotMessage(sid, replyText, "general");

    const prof = VOICE_PROFILES[currentSelectedVoice] || VOICE_PROFILES["jenna"];
    updateVoiceOrbState("speaking", `${prof.name} konuşuyor...`);

    const box = document.getElementById("voice-transcript-box");
    if (box) {
        box.textContent = `${prof.name}: ${replyText}`;
    }

    speakText(replyText, {
        voiceKey: currentSelectedVoice,
        onEnd: () => {
            if (isVoiceModeActive && !voiceModeMuted) {
                updateVoiceOrbState("listening", "Dinliyor...");
                isVoiceModeProcessing = false;
                try {
                    if (liveVoiceRecognition) liveVoiceRecognition.start();
                } catch (e) {}
            } else {
                isVoiceModeProcessing = false;
            }
        }
    });
}

// ============================================================
// 14. EXPORT & UTILS
// ============================================================

function clearCurrentChat() {
    if (confirm("Bu sohbeti temizlemek istediğinizden emin misiniz?")) {
        const session = getCurrentSession();
        if (session) {
            session.messages = [];
            saveChatSessions();
            renderCurrentSession();
        }
    }
}

function exportChat() {
    const session = getCurrentSession();
    if (!session || session.messages.length === 0) {
        alert("Dışa aktarılacak mesaj yok.");
        return;
    }

    let md = `# Lumina AI — ${session.title}\nTarih: ${new Date(session.timestamp).toLocaleString()}\n\n---\n\n`;
    session.messages.forEach(m => {
        const who = m.role === "user" ? "Kullanıcı" : "Lumina AI";
        const content = m.text || (m.imageData ? `[Görsel: ${m.imageData.original_prompt}](${m.imageData.image_url})` : "");
        md += `### ${who}:\n${content}\n\n`;
    });

    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lumina-chat-${session.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
}

function escapeHTML(str) {
    // Tırnakları da kaçırır: değerler HTML özniteliklerinde (alt="...") kullanılıyor.
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function jsonParseSafe(str, fallback) {
    try { return JSON.parse(str); } catch (e) { return fallback; }
}


// ============================================================
// 15. TERCİHLER, BİLDİRİMLER, ARKA PLAN İŞLERİ & KENDİLİĞİNDEN YAZMA
// ============================================================
// Mantık özeti:
//  • Soru sorulunca sunucuda bir "iş" (job) açılır. Uygulama arka plana alınsa,
//    WebView dondurulsa ya da kapatılsa bile cevap sunucuda üretilmeye devam eder.
//  • İş bilgisi localStorage'da tutulur; uygulama geri açılınca otomatik devam edilir
//    ve cevap doğru sohbete eklenir.
//  • Cevap/görsel hazır olunca (uygulama arka plandaysa) bildirim gönderilir.
//  • Ayarlar'da açıksa, kullanıcı bir süre yazmayınca Lumina kendiliğinden yazar.

const PREFS_KEY = "lumina_prefs";
const PENDING_KEY = "lumina_pending_jobs";
const PROACTIVE_KEY = "lumina_proactive_state";
const JOB_MAX_AGE_MS = 25 * 60 * 1000;

const DEFAULT_PREFS = { proactive: false, proactiveMinutes: 5, notify: true, keepAlive: true, sound: true, soundVolume: 85, streaming: false };
let prefs = { ...DEFAULT_PREFS, ...jsonParseSafe(localStorage.getItem(PREFS_KEY) || "{}", {}) };

let directBusy = false;
let lastActivityTs = Date.now();
let unreadCount = 0;
let baseTitle = document.title;
let proactiveInFlight = false;
let proactiveState = { unanswered: 0, lastTs: 0, ...jsonParseSafe(localStorage.getItem(PROACTIVE_KEY) || "{}", {}) };
const activePolls = new Set();
const sleepers = new Set();

function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
}
function saveProactiveState() {
    try { localStorage.setItem(PROACTIVE_KEY, JSON.stringify(proactiveState)); } catch (e) {}
}

// ---------- küçük yardımcılar ----------

// Erken uyandırılabilir bekleme: uygulama öne gelince beklemeler hemen biter.
function sleep(ms) {
    return new Promise((resolve) => {
        const done = () => { clearTimeout(t); sleepers.delete(done); resolve(); };
        const t = setTimeout(done, ms);
        sleepers.add(done);
    });
}
function wakeSleepers() { [...sleepers].forEach(fn => fn()); }

function waitVisible(maxMs = 60000) {
    if (!document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
        const onVis = () => { if (!document.hidden) { cleanup(); resolve(); } };
        const t = setTimeout(() => { cleanup(); resolve(); }, maxMs);
        function cleanup() { clearTimeout(t); document.removeEventListener("visibilitychange", onVis); }
        document.addEventListener("visibilitychange", onVis);
    });
}

function detailText(d) {
    if (!d) return "Bir hata oluştu.";
    if (typeof d === "string") return d;
    try { return JSON.stringify(d).slice(0, 300); } catch (e) { return "Bir hata oluştu."; }
}

function snippet(text, n = 110) {
    const t = String(text || "")
        .replace(/```[\s\S]*?```/g, " [kod] ")
        .replace(/\$\$[\s\S]*?\$\$/g, " [formül] ")
        .replace(/[*_#`>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function showToast(title, body = "", onClick = null, ms = 6000) {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const el = document.createElement("div");
    el.className = "toast";
    const strong = document.createElement("strong");
    strong.textContent = title;
    el.appendChild(strong);
    if (body) el.appendChild(document.createTextNode(body));
    const close = () => { if (el.parentNode) el.parentNode.removeChild(el); };
    el.addEventListener("click", () => { if (onClick) onClick(); close(); });
    stack.appendChild(el);
    setTimeout(close, ms);
}

// ---------- bekleyen işler (localStorage) ----------

function getPendingJobs() {
    const list = jsonParseSafe(localStorage.getItem(PENDING_KEY) || "[]", []);
    return Array.isArray(list) ? list : [];
}
function setPendingJobs(list) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch (e) {}
}
function addPendingJob(job) {
    const list = getPendingJobs().filter(j => j.id !== job.id);
    list.push(job);
    setPendingJobs(list);
}
function removePendingJob(id) {
    setPendingJobs(getPendingJobs().filter(j => j.id !== id));
}
function chatBusy() {
    return directBusy || getPendingJobs().some(j => j.kind === "chat");
}
function buildDirectHistory(sid, limit = 24) {
    const session = sessions.find(s => s.id === sid);
    if (!session) return [];
    return session.messages
        .filter(m => (m.role === "user" || m.role === "bot") && m.text)
        .slice(-limit)
        .map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
}

function restoreTypingIfPending() {
    const pending = getPendingJobs().find(j => j.sid === currentSessionId);
    if (pending) {
        showTypingIndicator(pending.kind === "image"
            ? "🎨 Görsel hazırlanıyor..."
            : "⏳ Lumina cevabı hazırlıyor (arka planda devam eder)...");
    }
}

// ---------- ekrana / sohbete teslim ----------

function deliverBotMessage(sid, text, agentMode = "general", opts = {}) {
    const session = sessions.find(s => s.id === sid);
    if (!session) return false;   // sohbet silinmiş
    if (sid === currentSessionId) {
        hideTypingIndicator();
        renderBotMessageElement(text, agentMode, true, opts);
    } else {
        const entry = { id: makeMessageId(), role: "bot", text, agentMode };
        if (opts.proactive) entry.proactive = true;
        session.messages.push(entry);
        saveChatSessions();
    }
    return true;
}

function deliverImageCard(sid, data) {
    const session = sessions.find(s => s.id === sid);
    if (!session) return false;
    if (sid === currentSessionId) {
        hideTypingIndicator();
        renderImageCardElement(data, true);
    } else {
        session.messages.push({ id: makeMessageId(), role: "image", imageData: data });
        saveChatSessions();
    }
    return true;
}

function notifyIfAway(title, body, sid, tag) {
    const away = document.hidden || !document.hasFocus();
    if (away) {
        notifyUser(title, body, { tag });
    } else if (sid !== currentSessionId) {
        showToast(title, body, () => switchSession(sid));
    }
}

function handleChatOutcome(sid, agentMode, status, data) {
    if (status === 200) {
        const reply = data.reply || "";
        const ok = deliverBotMessage(sid, reply, data.agent_mode || agentMode, {
            // Sunucu yanıtı güvenilir kaynaktır; sunucu taraflı tipler kabul edilir.
            smartUI: (Array.isArray(data.smart_ui) ? data.smart_ui : (data.smartUI || []))
                .map(b => sanitizeClientSmartBlock(b, { allowServerOnly: true }))
                .filter(Boolean),
            modelUsed: data.model_used || data.modelUsed || ""
        });
        if (data.quota) updateQuotaDisplay(data.quota); else fetchAndDisplayQuota();
        if (ok) {
            if (!document.hidden && sid === currentSessionId) speakText(reply);
            notifyIfAway("Lumina cevapladı 💬", snippet(reply), sid, "lumina-chat");
        }
    } else if (status === 403) {
        if (sid === currentSessionId) hideTypingIndicator();
        showQuotaExceededModal("message");
    } else {
        deliverBotMessage(sid, `⚠️ ${detailText(data && data.detail)}`, "general");
    }
    stopKeepAliveIfIdle();
}

// Görsel URL'si tarayıcıda yüklenince gerçekten "oluşmuş" olur (Pollinations o an üretir).
// Bu yüzden bildirim, resim yüklendikten sonra gönderilir.
async function preloadImage(url, tries = 3) {
    for (let i = 0; i < tries; i++) {
        if (document.hidden && i > 0) await waitVisible(60000);
        const candidate = i === 0 ? url : url.replace(/seed=\d+/, `seed=${Math.floor(Math.random() * 900000) + 10000}`);
        const ok = await new Promise((resolve) => {
            const img = new Image();
            const t = setTimeout(() => { img.src = ""; resolve(false); }, 120000);
            img.onload = () => { clearTimeout(t); resolve(true); };
            img.onerror = () => { clearTimeout(t); resolve(false); };
            img.src = candidate;
        });
        if (ok) return candidate;
    }
    return null;
}

async function presentGeneratedImage(sid, data) {
    const loadedUrl = await preloadImage(data.image_url);
    if (!loadedUrl) {
        deliverBotMessage(sid, "⚠️ Görsel sunucusu şu an yanıt vermedi. Biraz sonra tekrar dene.", "artist");
        stopKeepAliveIfIdle();
        return;
    }
    const ok = deliverImageCard(sid, { ...data, image_url: loadedUrl });
    if (ok) {
        if (!document.hidden && sid === currentSessionId) speakText("Görseliniz oluşturuldu.");
        notifyIfAway("Görselin hazır 🎨", snippet(data.original_prompt || "Görsel oluşturuldu."), sid, "lumina-image");
    }
    stopKeepAliveIfIdle();
}

async function handleImageOutcome(sid, status, data) {
    if (status === 403) {
        if (sid === currentSessionId) hideTypingIndicator();
        showQuotaExceededModal("image");
        stopKeepAliveIfIdle();
        return;
    }
    if (status === 200 && data.image_url) {
        if (data.quota) updateQuotaDisplay(data.quota); else fetchAndDisplayQuota();
        await presentGeneratedImage(sid, data);
        return;
    }
    // Sunucu yanıt verdi ama başarısız (ör. 400 = güvenlik reddi). Asla filtresiz yedeğe düşülmez.
    deliverBotMessage(sid, `⚠️ ${detailText(data && data.detail) || "Görsel oluşturulamadı."}`, "artist");
    stopKeepAliveIfIdle();
}

// ---------- iş takibi (polling) ----------

async function pollJob(job) {
    if (!hasBackend()) return;
    if (activePolls.has(job.id)) return;
    activePolls.add(job.id);
    const deadline = job.createdAt + JOB_MAX_AGE_MS;
    let delay = 1200;
    let netFails = 0;

    try {
        while (Date.now() < deadline) {
            let res = null, data = {};
            try {
                const token = await getAuthToken();
                res = await fetch(`${backendUrl}/jobs/${job.id}`, {
                    headers: { "Authorization": `Bearer ${token}` },
                    cache: "no-store"
                });
                data = await res.json().catch(() => ({}));
                netFails = 0;
            } catch (e) {
                netFails++;                       // uygulama arka plandayken ağ kesilebilir
                await sleep(Math.min(8000, 1500 * netFails));
                continue;
            }

            if (res.status === 404) {
                await finishJob(job, { status: 500, detail: "Sunucu yeniden başlatılmış olabilir; işlem kaybolmuş. Lütfen mesajını tekrar gönder." });
                return;
            }
            if (res.ok && data.status === "done") {
                await finishJob(job, null, data.result);
                return;
            }
            if (res.ok && data.status === "error") {
                await finishJob(job, data.error || { status: 500, detail: "İşlem başarısız oldu." });
                return;
            }
            if (!res.ok && res.status < 500 && res.status !== 429) {
                await finishJob(job, { status: res.status, detail: data.detail });
                return;
            }
            await sleep(delay);
            delay = Math.min(3000, delay + 300);
        }
        await finishJob(job, { status: 504, detail: "İşlem beklenenden uzun sürdü. Lütfen tekrar dene." });
    } finally {
        activePolls.delete(job.id);
    }
}

async function finishJob(job, error, result) {
    removePendingJob(job.id);

    if (!sessions.some(s => s.id === job.sid)) {   // sohbet bu arada silinmiş
        stopKeepAliveIfIdle();
        return;
    }

    if (job.kind === "image") {
        if (error) await handleImageOutcome(job.sid, error.status || 500, { detail: error.detail });
        else await handleImageOutcome(job.sid, 200, result || {});
    } else {
        if (error) handleChatOutcome(job.sid, job.agentMode, error.status || 500, { detail: error.detail });
        else handleChatOutcome(job.sid, job.agentMode, 200, result || {});
    }
}

function resumePendingJobs() {
    const fresh = getPendingJobs().filter(j => Date.now() - j.createdAt < JOB_MAX_AGE_MS && sessions.some(s => s.id === j.sid));
    setPendingJobs(fresh);
    fresh.forEach(j => pollJob(j));
    if (fresh.length) startKeepAlive();
}

// ---------- arka planda çalışmayı destekleme (best-effort) ----------
// Duyulmayan, sessiz bir Web Audio sinyali; bazı Chromium/WebView sürümlerinde
// sayfanın arka planda kısıtlanmasını azaltır. Garanti değildir — asıl güvence
// işin sunucuda devam etmesidir.

let keepAliveCtx = null;
let keepAliveNodes = null;

function startKeepAlive() {
    if (!prefs.keepAlive) return;
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!keepAliveCtx) keepAliveCtx = new AC();
        if (keepAliveCtx.state === "suspended") keepAliveCtx.resume().catch(() => {});
        if (!keepAliveNodes) {
            const osc = keepAliveCtx.createOscillator();
            const gain = keepAliveCtx.createGain();
            gain.gain.value = 0.00001;
            osc.frequency.value = 20;
            osc.connect(gain);
            gain.connect(keepAliveCtx.destination);
            osc.start();
            keepAliveNodes = { osc, gain };
        }
    } catch (e) { /* sessizce geç */ }
}

function stopKeepAliveIfIdle() {
    if (directBusy || getPendingJobs().length > 0) return;
    try { if (keepAliveNodes) keepAliveNodes.osc.stop(); } catch (e) {}
    keepAliveNodes = null;
    try { if (keepAliveCtx && keepAliveCtx.state === "running") keepAliveCtx.suspend(); } catch (e) {}
}

// ---------- bildirimler ----------

function canSystemNotify() {
    return ("Notification" in window) && Notification.permission === "granted";
}

async function requestNotifyPermission() {
    if (!("Notification" in window)) return "unsupported";
    if (Notification.permission === "default") {
        try { return await Notification.requestPermission(); } catch (e) { return "default"; }
    }
    return Notification.permission;
}

function maybeAskNotifyPermission() {
    if (!prefs.notify || localStorage.getItem("lumina_notif_asked")) return;
    if (!("Notification" in window) || Notification.permission !== "default") return;
    localStorage.setItem("lumina_notif_asked", "1");
    requestNotifyPermission().then(updateNotifStatus);
}

// Dikkat çekici, yüksek sesli bildirim melodisi: 4 notalık yükselen arpej x2.
// Ses seviyesi Ayarlar'daki çubuktan gelir (0-100). Her nota, tok bir "sine"
// ile parlak bir "triangle" katmanının toplamıdır; çıkışta sıkıştırıcı
// (compressor) olduğu için yüksek seviyede bile bozulmadan daha yüksek duyulur.
function playChime(volumeOverride) {
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!keepAliveCtx) keepAliveCtx = new AC();
        const ctx = keepAliveCtx;
        if (ctx.state === "suspended") ctx.resume().catch(() => {});

        const vol = Math.max(0, Math.min(100, volumeOverride ?? prefs.soundVolume ?? 85));
        if (vol === 0) return;
        const level = Math.pow(vol / 100, 1.4);        // algısal eğri: çubuk daha doğal hissettirir

        const master = ctx.createGain();
        master.gain.value = level;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        comp.attack.value = 0.002;
        comp.release.value = 0.15;
        master.connect(comp);
        comp.connect(ctx.destination);

        const notes = [784, 988, 1175, 1568];          // G5 B5 D6 G6
        const step = 0.13;
        const rounds = [0, 0.75];                      // melodi iki kez çalar
        rounds.forEach((offset) => {
            notes.forEach((freq, i) => {
                const t0 = ctx.currentTime + offset + i * step;
                const dur = i === notes.length - 1 ? 0.5 : 0.22;
                [["sine", 0.7], ["triangle", 0.45]].forEach(([type, amp]) => {
                    const osc = ctx.createOscillator();
                    const g = ctx.createGain();
                    osc.type = type;
                    osc.frequency.value = freq;
                    g.gain.setValueAtTime(0.0001, t0);
                    g.gain.exponentialRampToValueAtTime(amp, t0 + 0.012);
                    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
                    osc.connect(g);
                    g.connect(master);
                    osc.start(t0);
                    osc.stop(t0 + dur + 0.05);
                });
            });
        });
        setTimeout(() => { try { master.disconnect(); comp.disconnect(); } catch (e) {} }, 2500);
    } catch (e) {}
}

function updateTitleBadge() {
    document.title = unreadCount > 0 ? `(${unreadCount}) 🔔 ${baseTitle}` : baseTitle;
    try {
        if (unreadCount > 0 && navigator.setAppBadge) navigator.setAppBadge(unreadCount).catch(() => {});
        if (unreadCount === 0 && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch (e) {}
}

async function notifyUser(title, body, { tag = "lumina", force = false } = {}) {
    if (!prefs.notify && !force) return false;
    let shown = false;

    if (canSystemNotify()) {
        const options = { body, tag, renotify: true, vibrate: [250, 120, 250, 120, 400], requireInteraction: false };
        try {
            // Android Chrome'da "new Notification" çalışmaz; Service Worker üzerinden gösterilir.
            const reg = ("serviceWorker" in navigator) ? await navigator.serviceWorker.getRegistration() : null;
            if (reg && reg.showNotification) {
                await reg.showNotification(title, options);
                shown = true;
            }
        } catch (e) { /* aşağıdaki yedeğe geç */ }
        if (!shown) {
            try {
                const n = new Notification(title, { body, tag });
                n.onclick = () => { window.focus(); n.close(); };
                shown = true;
            } catch (e) {}
        }
    }

    // Yedek katmanlar (sistem bildirimi yoksa/gösterilemediyse de kullanıcı fark etsin)
    unreadCount++;
    updateTitleBadge();
    if (prefs.sound) {
        playChime();
        try { if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 400]); } catch (e) {}
    }
    return shown;
}

function updateNotifStatus() {
    const box = document.getElementById("notif-status");
    if (!box) return;
    let msg;
    if (!("Notification" in window)) {
        msg = "ℹ️ Bu ortamda sistem bildirimi desteklenmiyor. Uygulama içi uyarı, ses ve titreşim kullanılacak.";
    } else if (Notification.permission === "granted") {
        msg = "✅ Sistem bildirimleri açık.";
    } else if (Notification.permission === "denied") {
        msg = "⛔ Bildirim izni engellenmiş. Telefon ayarlarından bu uygulamaya bildirim izni ver.";
    } else {
        msg = "⚠️ Bildirim izni henüz verilmedi. Anahtarı açınca izin isteyeceğim.";
    }
    box.textContent = msg;
}

async function sendTestNotification() {
    await requestNotifyPermission();
    updateNotifStatus();
    showToast("Test başladı", "3 saniye içinde bildirim gelecek. Şimdi uygulamayı arka plana alabilirsin.");
    setTimeout(() => {
        notifyUser("Lumina test bildirimi 🔔", "Bildirimler çalışıyor.", { tag: "lumina-test", force: true });
    }, 3000);
}

// ---------- ayarlar arayüzü ----------

function refreshPrefsUI() {
    const setChecked = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    setChecked("pref-proactive", prefs.proactive);
    setChecked("pref-notify", prefs.notify);
    setChecked("pref-keepalive", prefs.keepAlive);
    setChecked("pref-sound", prefs.sound);
    setChecked("pref-streaming", prefs.streaming);
    const sel = document.getElementById("pref-proactive-minutes");
    if (sel) sel.value = String(prefs.proactiveMinutes);
    const vol = document.getElementById("pref-volume");
    if (vol) vol.value = String(prefs.soundVolume);
    const volLabel = document.getElementById("pref-volume-label");
    if (volLabel) volLabel.textContent = prefs.soundVolume + "%";
    const row = document.getElementById("pref-proactive-minutes-row");
    if (row) row.style.display = prefs.proactive ? "flex" : "none";
    updateNotifStatus();
}

async function onPrefToggle(key, value) {
    const map = { proactive: "proactive", notify: "notify", keepAlive: "keepAlive", sound: "sound", streaming: "streaming" };
    if (!(key in map)) return;
    prefs[key] = !!value;
    savePrefs();

    if (value && (key === "notify" || key === "proactive") && prefs.notify) {
        await requestNotifyPermission();
    }
    if (key === "streaming") {
        showToast(value ? "Canlı akış açık" : "Canlı akış kapalı",
            value ? "Yanıtlar harf harf yazılacak." : "Yanıtlar sunucuda tamamlanıp tek seferde gösterilecek.");
    }
    if (key === "proactive") {
        proactiveState.unanswered = 0;
        proactiveState.lastTs = Date.now();
        lastActivityTs = Date.now();
        saveProactiveState();
        showToast(value ? "Kendiliğinden yazma açık" : "Kendiliğinden yazma kapalı",
            value ? `Sen ${prefs.proactiveMinutes} dk yazmazsan Lumina seni yoklayabilir.` : "Lumina artık sadece sen yazınca cevap verir.");
    }
    if (key === "keepAlive" && !value) stopKeepAliveIfIdle();
    refreshPrefsUI();
}

let volumePreviewTimer = null;

function onVolumeInput(v) {
    const n = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
    prefs.soundVolume = n;
    savePrefs();
    const label = document.getElementById("pref-volume-label");
    if (label) label.textContent = n + "%";
    // Çubuk sürüklenirken sesi duyabilmek için kısa bir gecikmeyle önizleme çal
    clearTimeout(volumePreviewTimer);
    volumePreviewTimer = setTimeout(() => playChime(n), 250);
}

function previewSound() {
    playChime(prefs.soundVolume);
    try { if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 400]); } catch (e) {}
}

function onPrefMinutes(v) {
    const n = parseInt(v, 10);
    prefs.proactiveMinutes = [2, 5, 10, 30, 60].includes(n) ? n : 5;
    savePrefs();
}

// ---------- kendiliğinden yazma ----------

function noteUserActivity(isSend = false) {
    lastActivityTs = Date.now();
    if (isSend && proactiveState.unanswered !== 0) {
        proactiveState.unanswered = 0;
        saveProactiveState();
    }
}

async function fetchProactiveMessage() {
    const body = {
        idle_minutes: prefs.proactiveMinutes,
        local_time: new Date().toLocaleString("tr-TR"),
        unanswered: proactiveState.unanswered,
        custom_groq_key: directGroqKey || null
    };
    try {
        if (!hasBackend()) throw new Error("backend_yok");
        const token = await getAuthToken();
        const res = await fetch(`${backendUrl}/proactive`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify(body)
        });
        if (!res.ok) return null;
        const data = await res.json().catch(() => ({}));
        return data.reply || null;
    } catch (e) {
        if (!directGroqKey) return null;   // backend yok ve anahtar yok → sessizce vazgeç
    }

    // Sunucusuz mod
    try {
        const history = buildDirectHistory(currentSessionId, 10);
        const text = await callDirectGroq([
            { role: "system", content:
                "Sen Lumina AI'sın; samimi, sıcak bir dostsun. Kullanıcı bir süredir sessiz. Ona en fazla 2-3 cümlelik, " +
                "doğal ve baskısız bir mesaj yaz (gerekirse tek bir soru). Söyleyecek anlamlı bir şey yoksa sadece SKIP yaz. " +
                "Sadece mesajın kendisini yaz." },
            ...history,
            { role: "user", content: "(Sistem: kullanıcı sessiz. Şimdi kendiliğinden mesajını yaz ya da SKIP de.)" }
        ]);
        const t = (text || "").trim().replace(/^"|"$/g, "");
        return (!t || t.toUpperCase().startsWith("SKIP")) ? null : t;
    } catch (e) {
        return null;
    }
}

async function proactiveTick() {
    if (!prefs.proactive || proactiveInFlight) return;
    if (chatBusy() || getPendingJobs().length > 0) return;
    if (proactiveState.unanswered >= 3) return;   // cevap alamazsa susar

    const now = Date.now();
    const needed = prefs.proactiveMinutes * 60000 * (1 + proactiveState.unanswered);
    if (now - lastActivityTs < needed) return;
    if (now - proactiveState.lastTs < needed) return;

    const input = document.getElementById("user-input");
    if (input && input.value.trim()) return;      // kullanıcı bir şey yazıyor

    proactiveInFlight = true;
    proactiveState.lastTs = now;                  // hata olsa da art arda denenmesin
    saveProactiveState();
    const sid = currentSessionId;
    try {
        const text = await fetchProactiveMessage();
        if (text && prefs.proactive && !chatBusy()) {
            if (deliverBotMessage(sid, text, "general", { proactive: true })) {
                proactiveState.unanswered++;
                saveProactiveState();
                notifyIfAway("Lumina sana yazdı 💭", snippet(text), sid, "lumina-proactive");
            }
        }
    } catch (e) {
        console.debug("Proaktif mesaj alınamadı:", e);
    } finally {
        proactiveInFlight = false;
    }
}

// ---------- başlatma ----------

function initBackgroundFeatures() {
    baseTitle = document.title;

    // Service Worker (bildirimler için; yalnızca http/https'te çalışır)
    if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
        navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    // Kullanıcı hareketleri (boşta kalma süresini sıfırlar)
    ["pointerdown", "keydown", "touchstart", "scroll", "input"].forEach(ev =>
        document.addEventListener(ev, () => { lastActivityTs = Date.now(); }, { passive: true, capture: true }));

    // Uygulama öne gelince: bekleyen işlere hemen bak, bildirim sayacını sıfırla
    const onReturn = () => {
        if (document.hidden) return;
        lastActivityTs = Date.now();   // geri dönüşte anında "kendiliğinden yazma" tetiklenmesin
        unreadCount = 0;
        updateTitleBadge();
        wakeSleepers();
        getPendingJobs().forEach(j => {
            if (Date.now() - j.createdAt < JOB_MAX_AGE_MS) pollJob(j);
        });
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    window.addEventListener("pageshow", onReturn);
    window.addEventListener("online", wakeSleepers);

    // Yarım kalan işleri (uygulama kapanıp açıldıysa) devam ettir
    resumePendingJobs();

    setInterval(proactiveTick, 15000);
}


// ============================================================
// 16. CİHAZ İÇİ KALICI HAFIZA (sunucusuz / APK modu için)
// ============================================================
// Backend'e ulaşılamadığında (ör. APK'da) Lumina yine de seni hatırlasın diye
// isim ve kalıcı bilgiler localStorage'da tutulur ve her istekte modele eklenir.
// İsim tespiti backend'deki (main.py) kurallarla aynıdır: sorular ("adım ne?")
// ve duygu cümleleri ("ben yorgunum") isim sanılmaz.

const LOCAL_MEMORY_KEY = "lumina_local_memory";
const MAX_LOCAL_FACTS = 40;

const NAME_STOPWORDS = new Set([
    "ne","neydi","nedir","neymiş","neyse","nedenmiş","neden","niye","niçin","nasıl","kim","kimdir","kaç","hangi",
    "nerede","nereden","nereye","bir","biri","bu","şu","o","ben","sen","biz","siz","onlar","senin","onun","benim",
    "ve","ile","ama","fakat","yani","ki","de","da","mi","mı","mu","mü","için","gibi","kadar","diye","olarak",
    "değil","şey","hani","burada","şimdi","yorgun","mutlu","üzgün","hasta","iyi","kötü","biraz","çok","hâlâ",
    "hala","yine","artık","bile","sadece","aynı","farklı","hatırlıyor","hatırla","hatırlar","biliyor","biliyorsun",
    "söyle","söyler","unuttun","unuttum","değişti","değiştir","yaz","yazdım","yazdın","kaydet","olsun","olur",
    "tamam","evet","hayır","merhaba","selam","lütfen"
]);

const NAME_PATTERNS_JS = [
    /(?<![\p{L}])benim\s+ad[ıi]m\s+(\p{L}{2,24})/iu,
    /(?<![\p{L}])ad[ıi]m\s+(\p{L}{2,24})/iu,
    /(?<![\p{L}])benim\s+ismim\s+(\p{L}{2,24})/iu,
    /(?<![\p{L}])ismim\s+(\p{L}{2,24})/iu,
    /(?<![\p{L}])bana\s+(\p{L}{2,24})\s+(?:diyebilirsin|diyebilirsiniz|de(?![\p{L}])|diye\s+hitap)/iu,
    /(?<![\p{L}])beni\s+(\p{L}{2,24})\s+(?:olarak\s+çağır|diye\s+çağır)/iu,
    // "Ben Arel" — yalnızca büyük harfli gerçek isim (küçük harfli "ben yorgunum" kabul edilmez)
    /(?<![\p{L}])[Bb]en\s+([A-ZÇĞİÖŞÜ][a-zçğıöşü]{2,23})(?=\s*(?:[,.!]|$)|\s+diyorum(?![\p{L}])|\s+ve(?![\p{L}]))/u,
    // "Ben Arel'im", "Ben Ali'yim"
    /(?<![\p{L}])[Bb]en\s+([A-ZÇĞİÖŞÜ][a-zçğıöşü]{2,23})['’]\s*(?:y?[ıiuü]m)(?![\p{L}])/u,
];

const NAME_QUESTION_PATTERNS_JS = [
    /(?<![\p{L}])(?:benim\s+)?(?:ad[ıi]m|ismim)\s+(?:neydi|nedir|neymiş|ne\s+idi)(?![\p{L}])/iu,
    /(?<![\p{L}])(?:benim\s+)?(?:ad[ıi]m|ismim)\s+ne(?=\s*(?:[?.!,]|$)|\s+(?:olmuştu|demiştim|dedim|hatırl|biliyor))/iu,
    /(?<![\p{L}])(?:ad[ıi]m[ıi]|ismimi)\s+(?:biliyor|hatırl|söyle|unut)/iu,
    /(?<![\p{L}])ben\s+kimim(?![\p{L}])/iu,
];

const NAME_ANSWERS_JS = [
    "Adın {name}! Seni nasıl unuturum ki 😊",
    "Sen {name}'sın — adını aklımdan hiç çıkarmadım. 💛",
    "{name}! Adın {name}. Başka neyi hatırlamamı istersin?",
    "Tabii ki hatırlıyorum: adın {name}. 😊",
];

function trLower(s) { return String(s).replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase(); }
function trCapitalize(w) {
    if (!w) return w;
    return w.charAt(0).toLocaleUpperCase("tr") + trLower(w.slice(1));
}

function isValidName(c) {
    if (!c) return false;
    const t = String(c).trim();
    return t.length >= 2 && t.length <= 24 && /^\p{L}+$/u.test(t) && !NAME_STOPWORDS.has(trLower(t));
}

function extractNameClient(text) {
    if (!text) return null;
    let found = null;
    for (const sentence of String(text).split(/(?<=[.!?…])\s+|\n+/)) {
        for (const re of NAME_PATTERNS_JS) {
            const m = re.exec(sentence);
            if (!m) continue;
            const candidate = m[1].replace(/[ .,!?]/g, "");
            const rest = sentence.slice(m.index + m[0].length);
            if (/^\s+(?:mi|mı|mu|mü|miydi|mıydı)(?![\p{L}])/iu.test(rest)) continue;   // "adım Arel mi?"
            if (isValidName(candidate)) { found = trCapitalize(candidate); break; }
        }
    }
    return found;
}

function isNameQuestion(text) {
    return !!text && NAME_QUESTION_PATTERNS_JS.some(re => re.test(text));
}

function pickNameAnswer(name) {
    const t = NAME_ANSWERS_JS[Math.floor(Math.random() * NAME_ANSWERS_JS.length)];
    return t.replace(/\{name\}/g, name);
}

function loadLocalMemory() {
    const m = jsonParseSafe(localStorage.getItem(LOCAL_MEMORY_KEY) || "{}", {});
    return {
        name: isValidName(m.name) ? m.name : null,     // eski/bozuk isimler otomatik temizlenir
        facts: Array.isArray(m.facts) ? m.facts.filter(f => typeof f === "string" && f.trim()).slice(-MAX_LOCAL_FACTS) : []
    };
}

function saveLocalMemory(mem) {
    try {
        localStorage.setItem(LOCAL_MEMORY_KEY, JSON.stringify({
            name: isValidName(mem.name) ? mem.name : null,
            facts: (mem.facts || []).slice(-MAX_LOCAL_FACTS)
        }));
    } catch (e) {}
}

function clearLocalMemory() {
    try { localStorage.removeItem(LOCAL_MEMORY_KEY); } catch (e) {}
}

// Kullanıcı mesajından (ücretsiz, anında) isim yakalar ve saklar.
function rememberFromUserText(text) {
    const mem = loadLocalMemory();
    const name = extractNameClient(text);
    if (name && name !== mem.name) {
        mem.name = name;
        saveLocalMemory(mem);
    }
    return mem;
}

function buildLocalMemoryBlock(mem) {
    if (!mem || (!mem.name && !(mem.facts && mem.facts.length))) return "";
    const lines = ["🧠 KALICI HAFIZAN — Bu kullanıcı hakkında önceki konuşmalardan hatırladıkların:"];
    if (mem.name) {
        lines.push(`- Kullanıcının adı: ${mem.name}. Adını sorduğunda tereddüt etmeden doğrudan söyle; doğal biçimde hitap etmek istersen kullanabilirsin.`);
    }
    (mem.facts || []).forEach(f => lines.push(`- ${f}`));
    lines.push("Bu bilgileri gerçekten hatırlıyormuş gibi doğal kullan. Kullanıcı açıkça değiştirmediği sürece bu bilgileri asla unuttuğunu söyleme veya çelişme.");
    return lines.join("\n");
}

// Meslek, şehir, tercih gibi kalıcı bilgileri hafif bir model çağrısıyla çıkarır.
// Başarısız olursa sessizce vazgeçer; sohbeti asla bozmaz.
async function extractFactsClient(userText, botText) {
    if (!directGroqKey || !userText || userText.trim().split(/\s+/).length < 3) return;
    const mem = loadLocalMemory();
    try {
        const raw = await callDirectGroq([
            { role: "system", content:
                "You maintain a long-term memory profile about a chat user. You get the CURRENT facts as JSON and one new " +
                "user/assistant exchange (possibly Turkish). Extract only durable facts the user stated about THEMSELVES " +
                "(job, city, hobbies, preferences, family, pets, ongoing projects) — never the user's name and never facts " +
                "about other topics. Reply with ONLY a JSON object: {\"facts\": [\"short fact\", ...]}. Include all " +
                "still-true current facts plus new ones, deduplicated, each under 15 words, at most 40 items. " +
                "If nothing new was said, return the current facts unchanged. Never invent facts." },
            { role: "user", content:
                `CURRENT FACTS:\n${JSON.stringify({ facts: mem.facts })}\n\nNEW EXCHANGE:\nUser: ${userText}\nAssistant: ${botText}\n\nUpdated JSON:` }
        ], "openai/gpt-oss-20b");
        const json = (raw.match(/\{[\s\S]*\}/) || [null])[0];
        const parsed = json ? JSON.parse(json) : null;
        if (parsed && Array.isArray(parsed.facts)) {
            const latest = loadLocalMemory();   // bu arada isim değişmiş olabilir
            latest.facts = parsed.facts.map(f => String(f).trim()).filter(Boolean).slice(-MAX_LOCAL_FACTS);
            saveLocalMemory(latest);
        }
    } catch (e) {
        console.debug("Cihaz içi hafıza çıkarımı atlandı:", e);
    }
}

// ANCHOR-PLANS-SECTION


// ============================================================
// 17. ABONELİK & PAKETLER MODALI (EKSİK FONKSİYONLARIN YENİSİ)
// 10 sunucu yetkili paket; kart, karşılaştırma, custom sihirbaz ve
// Duo/Aile yönetimi. Veri kaynağı: backend `/plans` (+ bağlantı
// kesilirse yerel katalog yedeği).
// ============================================================

const PLAN_DATA_FALLBACK = {
    standart: { id: "standart", name: "Standart Paket", price_tl: 0, badge: "Ücretsiz", model_tier: "Standart (Gemini 3.6 Flash / GPT-OSS 120B)", messages_per_day: 250, images_per_day: 5, images_per_conversation: 5, max_members: 1, is_unlimited_text: false, is_unlimited_image: false, recommended: false, features: ["Günde 250 sohbet mesajı", "Günde 5 ultra gerçekçi görsel", "Standart modellere erişim", "Smart UI desteği"] },
    ekonomi: { id: "ekonomi", name: "Ekonomi Paket", price_tl: 150, badge: "Popüler", model_tier: "Hızlı & Gelişmiş (Gemini 3.5 Flash / GPT-OSS 20B)", messages_per_day: 1000, images_per_day: 25, images_per_conversation: 15, max_members: 1, recommended: false, features: ["Günde 1.000 mesaj", "Günde 25 görsel", "Gelişmiş akıl yürütme", "Canlı web araştırması"] },
    duo_ekonomi: { id: "duo_ekonomi", name: "Duo Boyu Ekonomi", price_tl: 300, badge: "2 Kişilik", model_tier: "Hızlı & Gelişmiş", messages_per_day: 1500, images_per_day: 35, images_per_conversation: 20, max_members: 2, recommended: false, features: ["2 ayrı yetkili hesap", "Bağımsız gizli sohbetler", "Kişi başı 1.500 mesaj", "Davet paneli"] },
    aile_ekonomi: { id: "aile_ekonomi", name: "Aile Boyu Ekonomi", price_tl: 400, badge: "Aile (3-5)", model_tier: "Hızlı & Gelişmiş", messages_per_day: 2000, images_per_day: 50, images_per_conversation: 25, max_members: 5, recommended: false, features: ["3-5 yetkili aile üyesi", "Bağımsız kullanım", "Günde 50 görsel", "Aile paneli"] },
    pro: { id: "pro", name: "Pro Paket", price_tl: 500, badge: "Profesyonel", model_tier: "Premium Gemini (3.8 Flash / 3.6 Flash)", messages_per_day: 3000, images_per_day: 60, images_per_conversation: 30, max_members: 1, recommended: true, features: ["Premium Gemini modelleri", "Günde 3.000 mesaj", "Günde 60 görsel", "Çoklu ajan yazılım hattı"] },
    pro_plus: { id: "pro_plus", name: "Pro+ Paket", price_tl: 650, badge: "Gelişmiş Pro", model_tier: "En İyi Gemini (3.8 Flash)", messages_per_day: 5000, images_per_day: 80, images_per_conversation: 40, max_members: 1, is_unlimited_text: true, recommended: false, features: ["Sınırsız metin (Adil kullanım 5.000/gün)", "Günde 80 görsel", "Üstün kod yazımı", "Öncelikli destek"] },
    luks: { id: "luks", name: "Lüks Paket", price_tl: 850, badge: "Lüks", model_tier: "En İyi Gemini + Düşük Gecikme", messages_per_day: 7500, images_per_day: 120, images_per_conversation: 50, max_members: 1, is_unlimited_text: true, is_unlimited_image: true, recommended: false, features: ["Sınırsız metin (7.500/gün)", "Sınırsız görsel (120/gün)", "En düşük gecikme", "VIP sunucu tahsisi"] },
    premium: { id: "premium", name: "Premium Paket", price_tl: 900, badge: "Premium", model_tier: "Amiral Gemisi Model Yönlendirmesi", messages_per_day: 10000, images_per_day: 150, images_per_conversation: 60, max_members: 1, is_unlimited_text: true, is_unlimited_image: true, recommended: false, features: ["Akıllı model yönlendirme", "Sınırsız sohbet (10.000/gün)", "Sınırsız görsel", "7/24 yüksek öncelik"] },
    premium_plus: { id: "premium_plus", name: "Premium Plus", price_tl: 1000, badge: "En Üst Seviye", model_tier: "Amiral Gemisi + Özel Yönlendirme", messages_per_day: 15000, images_per_day: 200, images_per_conversation: 100, max_members: 1, is_unlimited_text: true, is_unlimited_image: true, recommended: false, features: ["Tüm amiral gemisi modelleri", "En yüksek öncelik", "Beta özellikleri", "Kurumsal güvenilirlik"] },
    custom: { id: "custom", name: "Custom Paket (Özel)", price_tl: 0, badge: "Özel Tasarım", model_tier: "Kullanıcı Seçimi", messages_per_day: 0, images_per_day: 0, images_per_conversation: 10, max_members: 1, recommended: false, features: ["İhtiyaca özel kota", "Model seviyesi seçimi", "Ek koltuk seçimi", "Şeffaf maliyet dökümü"] }
};

const PLAN_CARD_ORDER = ["standart", "ekonomi", "duo_ekonomi", "aile_ekonomi", "pro", "pro_plus", "luks", "premium", "premium_plus", "custom"];
let plansCache = { data: null, ts: 0 };
let activePlanId = null;               // kullanıcının anlık paketi (backend /subscription)
let currentCustomConfig = { messages_per_day: 1000, images_per_day: 20, model_tier: "pro", seats: 1 };
let customPriceTimer = null;

async function fetchPlansCatalog(force = false) {
    if (!force && plansCache.data && Date.now() - plansCache.ts < 600000) return plansCache.data;
    if (!hasBackend()) {
        plansCache = { data: { ...PLAN_DATA_FALLBACK }, ts: Date.now() };
        return plansCache.data;
    }
    try {
        const res = await fetch(`${backendUrl}/plans`, { cache: "no-store" });
        if (res.ok) {
            const data = await res.json();
            if (data && Array.isArray(data.plans) && data.plans.length) {
                const merged = { ...PLAN_DATA_FALLBACK };
                data.plans.forEach(p => { if (p && p.id) merged[p.id] = p; });
                plansCache = { data: merged, ts: Date.now() };
                return plansCache.data;
            }
        }
    } catch (e) { /* backend yok → yerel katalog */ }
    plansCache = { data: { ...PLAN_DATA_FALLBACK }, ts: Date.now() };
    return plansCache.data;
}

function openPlansModal() {
    const modal = document.getElementById("plans-modal");
    if (!modal) return;
    modal.style.display = "flex";
    switchPlansTab("cards");
    fetchPlansCatalog(true).then(() => { renderPlanCards(); renderComparisonTable(); });
    fetchSubscriptionDetails();
}

function closePlansModal() {
    const modal = document.getElementById("plans-modal");
    if (modal) modal.style.display = "none";
}

function switchPlansTab(tab) {
    const contents = ["cards", "compare", "custom", "family"];
    contents.forEach(t => {
        const el = document.getElementById(`plans-tab-${t}`);
        if (el) el.style.display = (t === tab) ? "" : "none";
    });
    document.querySelectorAll(".plans-nav-tab").forEach(btn => {
        btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
    });
    if (tab === "custom") onCustomSliderChange();
}

async function fetchSubscriptionDetails() {
    if (!hasBackend()) return;
    try {
        const token = await getAuthToken();
        const res = await fetch(`${backendUrl}/subscription`, {
            headers: { "Authorization": `Bearer ${token}` },
            cache: "no-store"
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.quota) updateQuotaDisplay(data.quota);
        if (data.current_plan && data.current_plan.id) {
            activePlanId = data.current_plan.id;
            renderPlanCards();
            if (data.family_members) {
                renderFamilyMembers(data.family_members, data.current_plan.max_members || 1, data.current_plan.name || "");
            }
        }
    } catch (e) { /* backend yok */ }
}

function renderPlanCards() {
    const container = document.getElementById("plans-cards-container");
    if (!container) return;
    const catalog = plansCache.data || PLAN_DATA_FALLBACK;

    container.innerHTML = PLAN_CARD_ORDER.map(pid => {
        const p = catalog[pid];
        if (!p) return "";
        const price = p.price_tl === 0 ? "Ücretsiz" : `${formatTRNumber(p.price_tl)} TL`;
        const isActive = activePlanId === p.id;
        const classes = ["plan-card"];
        if (p.recommended) classes.push("recommended");
        if (isActive) classes.push("active-plan");
        const featureList = (p.features || []).slice(0, 5).map(f =>
            `<li class="plan-feature-item"><span class="plan-feature-check">✓</span><span>${escapeHTML(f)}</span></li>`).join("");
        const button = isActive
            ? `<button class="modal-action-btn" style="background:var(--bg-card); color:#10b981; border:1px solid #10b981; cursor:default;">✓ Aktif Paketin</button>`
            : `<button class="modal-action-btn" onclick="selectPlan('${p.id}')">Seç</button>`;
        return `
        <div class="${classes.join(" ")}">
            ${p.badge ? `<span class="plan-badge-top ${isActive ? "active-badge" : toClassBadge(p.id)}">${escapeHTML(p.badge)}</span>` : ""}
            <div class="plan-header">
                <div class="plan-title">${escapeHTML(p.name)}</div>
                <div class="plan-desc">${escapeHTML(p.model_tier || "")}</div>
            </div>
            <div class="plan-price-wrap">
                <span class="plan-price-num">${price}</span>
                <span class="plan-price-period">/aylık</span>
            </div>
            <ul class="plan-features-list">${featureList}</ul>
            ${button}
        </div>`;
    }).join("");
}

function toClassBadge(pid) {
    const map = { ekonomi: "plan-badge-top", pro: "plan-badge-top", custom: "plan-badge-top" };
    return map[pid] || "plan-badge-top";
}

async function selectPlan(planId) {
    if (!requireBackend("Paket seçimi")) return;
    showToast("Paket seçiliyor", "Sunucu onayı alınıyor...");
    try {
        const token = await getAuthToken();
        const res = await fetch(`${backendUrl}/subscription/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ plan_id: planId })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            activePlanId = planId;
            showToast("Paket Aktif Edildi", data.message || "Paketiniz seçildi.", null);
            if (data.quota) updateQuotaDisplay(data.quota);
            renderPlanCards();
            renderComparisonTable();
        } else {
            showToast("Paket Seçilemedi", detailText(data.detail), null, 8000);
        }
    } catch (e) {
        showToast("Bağlantı Hatası", "Paket seçimi için backend sunucusuna ulaşılamadı.", null, 8000);
    }
}

function renderComparisonTable() {
    const container = document.getElementById("plans-comparison-container");
    if (!container) return;
    const catalog = plansCache.data || PLAN_DATA_FALLBACK;
    const ids = PLAN_CARD_ORDER.filter(pid => pid !== "custom");
    const rows = [
        { label: "Aylık Fiyat", get: p => p.price_tl === 0 ? "Ücretsiz" : `${formatTRNumber(p.price_tl)} TL` },
        { label: "Model Seviyesi", get: p => p.model_tier || "-" },
        { label: "Günlük Mesaj", get: p => p.is_unlimited_text ? "Sınırsız ∞ (adil kullanım)" : formatTRNumber(p.messages_per_day) },
        { label: "Günlük Görsel", get: p => p.is_unlimited_image ? "Sınırsız ∞ (adil kullanım)" : formatTRNumber(p.images_per_day) },
        { label: "Sohbet Başına Görsel", get: p => p.images_per_conversation ?? "-" },
        { label: "Üye Sayısı", get: p => p.max_members > 1 ? `${p.max_members} kişilik` : "1 kişi" }
    ];

    const head = ids.map(pid => `<th>${escapeHTML((catalog[pid] || {}).name || pid)}</th>`).join("");
    const body = rows.map(r =>
        `<tr><th>${escapeHTML(r.label)}</th>${ids.map(pid => `<td>${escapeHTML(String(r.get(catalog[pid] || {})))}</td>`).join("")}</tr>`
    ).join("");

    container.innerHTML = `
        <table class="comparison-table">
            <thead><tr><th>Özellik</th>${head}</tr></thead>
            <tbody>${body}</tbody>
        </table>
        <p style="margin-top:10px; font-size:11px; color:var(--text-muted);">Sunucu yetkili abonelik: kotalar ve modeller sunucuda doğrulanır. Ödeme altyapısı entegrasyonuna kadar değerler <strong>önizleme</strong> niteliğindedir.</p>
    `;
}

function formatTRNumber(n) {
    try { return Number(n || 0).toLocaleString("tr-TR"); } catch (e) { return String(n); }
}

// ---------- CUSTOM PAKET SİHİRBAZI ----------

function selectCustomModelTier(tier) {
    if (!["standard", "pro", "flagship"].includes(tier)) tier = "standard";
    currentCustomConfig.model_tier = tier;
    document.querySelectorAll("#custom-model-tier-pills .choice-pill").forEach(p => {
        p.classList.toggle("active", p.getAttribute("data-tier") === tier);
    });
    onCustomSliderChange();
}

async function onCustomSliderChange() {
    const msgRange = document.getElementById("custom-range-msg");
    const imgRange = document.getElementById("custom-range-img");
    const seatsRange = document.getElementById("custom-range-seats");
    if (!msgRange || !imgRange) return;

    currentCustomConfig.messages_per_day = parseInt(msgRange.value, 10) || 1000;
    currentCustomConfig.images_per_day = parseInt(imgRange.value, 10) || 20;
    currentCustomConfig.seats = parseInt(seatsRange ? seatsRange.value : "1", 10) || 1;

    const msgVal = document.getElementById("custom-val-msg");
    const imgVal = document.getElementById("custom-val-img");
    const seatsVal = document.getElementById("custom-val-seats");
    if (msgVal) msgVal.textContent = `${formatTRNumber(currentCustomConfig.messages_per_day)} Mesaj`;
    if (imgVal) imgVal.textContent = `${formatTRNumber(currentCustomConfig.images_per_day)} Görsel`;
    if (seatsVal) seatsVal.textContent = `${currentCustomConfig.seats} Kişi`;

    clearTimeout(customPriceTimer);
    customPriceTimer = setTimeout(fetchCustomPrice, 300);
}

async function fetchCustomPrice() {
    const cfg = currentCustomConfig;
    let data = null;
    if (hasBackend()) {
        try {
            const res = await fetch(`${backendUrl}/plans/custom-calculate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                messages_per_day: cfg.messages_per_day,
                images_per_day: cfg.images_per_day,
                model_tier: cfg.model_tier,
                seats: cfg.seats,
                enable_web_research: true,
                enable_code_assistant: true,
                extra_storage_mb: 100
            })
        });
        if (res.ok) data = await res.json();
    } catch (e) { /* yerel hesap yedeği */ }
    }
    renderCustomBreakdown(data);
}

function localCustomPrice(cfg) {
    // Backend yoksa sunucudaki fiyat formülüyle birebir eşdeğer yerel hesap
    const base = 75.0;
    const msgCost = (cfg.messages_per_day / 1000.0) * 35.0;
    const imgCost = (cfg.images_per_day / 10.0) * 20.0;
    const tierMult = { standard: 1.0, pro: 1.45, flagship: 1.95 }[cfg.model_tier] || 1.45;
    const addons = 25.0 + 35.0 + (100 / 500.0) * 15.0;
    const single = (base + msgCost + imgCost + addons) * tierMult;
    let total = single + (cfg.seats - 1) * (single * 0.65);
    total = Math.max(100, Math.round(total / 10) * 10);
    return total;
}

function renderCustomBreakdown(data) {
    const details = document.getElementById("custom-breakdown-details");
    const totalEl = document.getElementById("custom-total-price");
    if (!details || !totalEl) return;

    const cfg = currentCustomConfig;
    if (data && data.success && data.breakdown) {
        const b = data.breakdown;
        details.innerHTML = `
            Altyapı: <strong>${formatTRNumber(b.base_platform_fee_tl)} TL</strong><br>
            Mesaj kotası: <strong>${formatTRNumber(b.message_quota_fee_tl)} TL</strong><br>
            Görsel kotası: <strong>${formatTRNumber(b.image_quota_fee_tl)} TL</strong><br>
            Modüller (web + kod): <strong>${formatTRNumber(b.addons_fee_tl)} TL</strong><br>
            Model çarpanı: <strong>${escapeHTML(String(b.model_tier))} × ${b.model_tier_multiplier}</strong><br>
            Koltuk: <strong>${b.seats} kişi</strong>
        `;
        totalEl.textContent = `${formatTRNumber(data.price_tl)} TL`;
        localStorage.setItem("lumina_custom_plan", JSON.stringify({ config: cfg, price_tl: data.price_tl }));
    } else {
        const total = localCustomPrice(cfg);
        details.innerHTML = `<span style="color:var(--text-muted);">(Sunucuya ulaşılamadı; fiyat yerel motorla hesaplandı — satın alım anında sunucu onaylı fiyat uygulanır.)</span>`;
        totalEl.textContent = `${formatTRNumber(total)} TL`;
        localStorage.setItem("lumina_custom_plan", JSON.stringify({ config: cfg, price_tl: total }));
    }
}

async function selectCustomPlan() {
    if (!requireBackend("Özel paket onayı")) return;
    const cfg = currentCustomConfig;
    showToast("Özel paket hazırlanıyor", "Sunucu onayı alınıyor...");
    try {
        const token = await getAuthToken();
        const res = await fetch(`${backendUrl}/subscription/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({
                plan_id: "custom",
                custom_config: {
                    messages_per_day: cfg.messages_per_day,
                    images_per_day: cfg.images_per_day,
                    model_tier: cfg.model_tier,
                    seats: cfg.seats,
                    enable_web_research: true,
                    enable_code_assistant: true,
                    extra_storage_mb: 100
                }
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            activePlanId = "custom";
            showToast("Özel Paket Aktif", data.message || "Custom paketin sunucu onayıyla aktif edildi.");
            if (data.quota) updateQuotaDisplay(data.quota);
            renderPlanCards();
            renderComparisonTable();
            closePlansModal();
        } else {
            showToast("Paket Onaylanamadı", detailText(data.detail), null, 8000);
        }
    } catch (e) {
        showToast("Bağlantı Hatası", "Custom paket için backend sunucusuna ulaşılamadı.", null, 8000);
    }
}

// ---------- DUO & AİLE ÜYE YÖNETİMİ ----------

async function sendFamilyInvite() {
    const input = document.getElementById("family-invite-email");
    const email = input ? input.value.trim().toLowerCase() : "";
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        showToast("Geçersiz E-posta", "Lütfen davet etmek için geçerli bir e-posta adresi girin.", null, 7000);
        return;
    }
    if (!requireBackend("Üye daveti")) return;
    try {
        const token = await getAuthToken();
        const res = await fetch(`${backendUrl}/memberships/invite`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ email })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast("Üye Eklendi", data.message || `${email} ekibe eklendi.`);
            if (input) input.value = "";
            fetchSubscriptionDetails();  // listeyi tazele (kontenjan dâhil)
        } else {
            showToast("Üye Eklenemedi", detailText(data.detail), null, 8000);
        }
    } catch (e) {
        showToast("Bağlantı Hatası", "Üye daveti için backend sunucusuna ulaşılamadı.", null, 8000);
    }
}

function renderFamilyMembers(members, maxMembers) {
    const list = document.getElementById("family-members-list");
    if (!list) return;
    const arr = Array.isArray(members) ? members : [];
    if (!arr.length) {
        list.innerHTML = `<span style="font-size:12px; color:var(--text-muted);">Henüz eklenmiş üye yok.</span>`;
        return;
    }
    const limitText = maxMembers && maxMembers > 1 ? ` (kontenjan: ${arr.length}/${maxMembers})` : "";
    list.innerHTML = arr.map(m => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:8px 12px;">
            <span style="font-size:12.5px;">👤 ${escapeHTML(m.email || "")} ${m.invited_at ? `<small style="color:var(--text-muted);">• ${new Date(m.invited_at * 1000).toLocaleDateString("tr-TR")}</small>` : ""}</span>
            <button class="history-del-btn" style="opacity:1;" onclick="removeFamilyMember('${escapeHTML(m.email || "")}')" title="Üyeyi çıkar">✕</button>
        </div>
    `).join("") + (limitText ? `<small style="font-size:11px;color:var(--text-muted); margin-top:4px;">${limitText}</small>` : "");
}

async function removeFamilyMember(email) {
    if (!email) return;
    if (!requireBackend("Üye çıkarma")) return;
    if (!confirm(`${email} üyesini ekibinden çıkarmak istediğine emin misin?`)) return;
    try {
        const token = await getAuthToken();
        const res = await fetch(`${backendUrl}/memberships/${encodeURIComponent(email)}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${token}` }
        });
        if (res.ok) {
            showToast("Üye Çıkarıldı", `${email} ve yayılan paket yetkisi geri alındı.`);
            fetchSubscriptionDetails();
        } else {
            const data = await res.json().catch(() => ({}));
            showToast("Üye Çıkarılamadı", detailText(data.detail), null, 8000);
        }
    } catch (e) {
        showToast("Bağlantı Hatası", "Üye çıkarma için backend sunucusuna ulaşılamadı.", null, 8000);
    }
}


// ============================================================
// 18. BELGE EKLEME AKIŞI (DOCS ANALYZE & ATTACH)
// ============================================================

let currentAttachedDoc = null;
let isUploadingDoc = false;
// Backend'den güncellenir; erişilemezse güvenli varsayılan kullanılır.
let MAX_DOC_UPLOAD_MB = 25;

async function loadFileFormatCatalog() {
    if (!hasBackend()) return;
    try {
        const res = await fetch(`${backendUrl}/files/formats`);
        if (!res.ok) return;
        const data = await res.json();
        const limit = Number(data.max_upload_mb);
        if (limit > 0) MAX_DOC_UPLOAD_MB = limit;
        const exts = [];
        (Array.isArray(data.categories) ? data.categories : []).forEach(cat => {
            (Array.isArray(cat.formats) ? cat.formats : []).forEach(fmt => {
                (Array.isArray(fmt.extensions) ? fmt.extensions : []).forEach(ext => {
                    if (ext) exts.push(`.${ext}`);
                });
            });
        });
        const input = document.getElementById("doc-upload-input");
        if (input && exts.length) input.setAttribute("accept", exts.join(","));
    } catch (e) {
        // Çevrimdışı: varsayılan 25 MB sınırı ve geniş uzantı listesi geçerli.
    }
}

function triggerDocUpload() {
    const input = document.getElementById("doc-upload-input");
    if (input && !isUploadingDoc) input.click();
}

async function handleDocUpload(event) {
    const fileEl = event.target;
    const file = fileEl && fileEl.files && fileEl.files[0];
    if (!file) return;

    if (file.size > MAX_DOC_UPLOAD_MB * 1024 * 1024) {
        showToast("Dosya Çok Büyük", `Belge en fazla ${MAX_DOC_UPLOAD_MB} MB olabilir.`, null, 7000);
        fileEl.value = "";
        return;
    }
    if (isUploadingDoc) return;
    if (!requireBackend("Belge analizi")) {
        fileEl.value = "";
        return;
    }
    isUploadingDoc = true;
    showToast("Belge analiz ediliyor", `${file.name} işleniyor...`);

    try {
        const token = await getAuthToken();
        const form = new FormData();
        form.append("file", file);

        const res = await fetch(`${backendUrl}/documents/analyze`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}` },
            body: form
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast("Belge İşlenemedi", detailText(data.detail), null, 9000);
            fileEl.value = "";
            return;
        }
        currentAttachedDoc = {
            filename: data.filename || file.name,
            excerpt: data.excerpt || data.preview || "",
            characters: data.characters || 0,
            filetype: data.filetype || "text",
            categoryLabel: data.category_label || data.category || "Belge",
            warnings: Array.isArray(data.warnings) ? data.warnings : [],
            metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : {}
        };
        renderAttachedDocPill(true);
        showToast(
            "Belge Eklendi",
            `${data.filename} • ${currentAttachedDoc.categoryLabel} • ${formatTRNumber(data.characters)} karakter. Sorunu yazıp gönderebilirsin.`
        );
        if (currentAttachedDoc.warnings.length) {
            showToast("Analiz Notu", currentAttachedDoc.warnings[0], null, 8000);
        }
    } catch (e) {
        showToast("Bağlantı Hatası", "Belge analizi için backend sunucusuna ulaşılamadı.", null, 8000);
    } finally {
        isUploadingDoc = false;
        if (fileEl) fileEl.value = "";
    }
}

function clearAttachedDoc() {
    currentAttachedDoc = null;
    renderAttachedDocPill(false);
}

function renderAttachedDocPill(show) {
    const pill = document.getElementById("attached-doc-pill");
    const name = document.getElementById("attached-doc-name");
    if (!pill) return;
    if (show && currentAttachedDoc) {
        pill.style.display = "flex";
        const label = currentAttachedDoc.categoryLabel ? ` • ${currentAttachedDoc.categoryLabel}` : "";
        if (name) name.textContent = `📄 ${currentAttachedDoc.filename}${label} (${formatTRNumber(currentAttachedDoc.characters)} karakter)`;
    } else {
        pill.style.display = "none";
        if (name) name.textContent = "📄 Belge eklendi";
    }
}


// ============================================================
// 19. SMART UI RENDERER (GÜVENLİ BİLEŞENLER)
// AI'in ürettiği JSON şemaları ""; hiçbir rastgele JavaScript
// YÜRÜTMEZ. Hesap makinesi dâhil her şey kapalı yardımlı ayracı
// (kendi yazdığım mini ayracı) ile değerlendirilir.
// ============================================================

const CLIENT_SMART_UI_REGEX = /```smart-ui\s*([\s\S]*?)```/i;

function parseClientSmartUIBlocks(text) {
    if (!text) return { blocks: [], clean: text };
    const m = CLIENT_SMART_UI_REGEX.exec(text);
    if (!m) return { blocks: [], clean: text };
    const blocks = [];
    // En fazla 3 blok okunur (spam koruması)
    let remaining = text;
    for (let i = 0; i < 3 && remaining; i++) {
        const match = CLIENT_SMART_UI_REGEX.exec(remaining);
        if (!match) break;
        const parsed = jsonParseSafe(match[1], null);
        if (parsed && parsed.type) blocks.push(parsed);
        remaining = remaining.replace(match[0], "");
    }
    return { blocks, clean: remaining.trim() };
}

function stripClientSmartUI(text) {
    const { clean } = parseClientSmartUIBlocks(text);
    return clean;
}

// --- Mini güvenli hesap ayracı: eval/YOK; kendi tokenizer + önceliği ---
function safeCalcExpression(expr) {
    if (typeof expr !== "string" || !expr.trim()) return null;
    const cleaned = expr.replace(/,/g, ".").replace(/×/g, "*").replace(/÷/g, "/").replace(/\^/g, "^");
    if (/[^0-9+\-*/().%\s^]/.test(cleaned)) return null;
    let pos = 0;
    const peek = () => cleaned[pos];
    const skipWs = () => { while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++; };
    function parseNumber() {
        skipWs();
        let start = pos;
        while (pos < cleaned.length && /[0-9.]/.test(cleaned[pos])) pos++;
        if (start === pos) return null;
        const num = parseFloat(cleaned.slice(start, pos));
        return isNaN(num) ? null : num;
    }
    function parsePrimary() {
        skipWs();
        if (peek() === "(") {
            pos++;
            const v = parseExpression();
            skipWs();
            if (peek() === ")") pos++;
            return v;
        }
        if (peek() === "-") { pos++; const v = parsePrimary(); return -v; }
        if (peek() === "+") { pos++; return parsePrimary(); }
        return parseNumber();
    }
    function parsePower() {
        let base = parsePrimary();
        skipWs();
        if (peek() === "^") { pos++; const exp = parsePower(); return (base === null || exp === null) ? null : Math.pow(base, exp); }
        return base;
    }
    function parseTerm() {
        let value = parsePower();
        while (value !== null) {
            skipWs();
            const op = peek();
            if (op === "*" || op === "/" || op === "%") {
                pos++;
                const rhs = parsePower();
                if (rhs === null) return null;
                if (op === "*") value = value * rhs;
                else if (op === "/") value = rhs === 0 ? Infinity : value / rhs;
                else value = value % rhs;
            } else break;
        }
        return value;
    }
    function parseExpression() {
        let value = parseTerm();
        while (value !== null) {
            skipWs();
            const op = peek();
            if (op === "+" || op === "-") {
                pos++;
                const rhs = parseTerm();
                if (rhs === null) return null;
                value = op === "+" ? value + rhs : value - rhs;
            } else break;
        }
        return value;
    }
    const result = parseExpression();
    skipWs();
    if (pos !== cleaned.length || result === null || !isFinite(result) || isNaN(result)) return null;
    return Math.round(result * 1e6) / 1e6;
}

// Merkezi Smart UI kaydı: yalnızca burada tanımlı tipler render edilir.
// Bilinmeyen tip sessizce yok sayılır; dinamik kod çalıştırılmaz.
const SMART_UI_BUILDERS = {
    calculator: buildSmartCalculator,
    task_manager: buildSmartTaskManager,
    budget_planner: buildSmartBudgetPlanner,
    calendar: buildSmartCalendar,
    unit_converter: buildSmartUnitConverter,
    project_roadmap: buildSmartRoadmap,
    study_planner: buildSmartStudyPlanner,
    comparison_table: buildSmartComparisonTable,
    interactive_form: buildSmartInteractiveForm,
    checklist: buildSmartChecklist,
    progress_tracker: buildSmartProgressTracker,
    data_table: buildSmartDataTable,
    // Canlı konum/hava/rota blokları: yalnızca sunucu üretir ve
    // location_ui.js içindeki güvenli DOM oluşturucularıyla çizilir.
    location_results: buildSmartLocationResults,
    weather_forecast: buildSmartWeatherForecast,
    route_info: buildSmartRouteInfo,
    location_request: buildSmartLocationRequest,
    location_info: buildSmartLocationInfo
};

// Yalnızca SUNUCU tarafından üretilebilen tipler. Model çıktısındaki
// aynı tipler istemcide reddedilir; böylece model koordinat, işletme,
// hava durumu veya rota uyduramaz.
const SERVER_ONLY_UI_TYPES = new Set([
    "location_results",
    "weather_forecast",
    "route_info",
    "location_request",
    "location_info"
]);

// location_ui.js yüklenmemişse bu tipler sessizce atlanır (uydurma veri yok).
function _locationUi() {
    return (typeof window !== "undefined" && window.LuminaLocation) ? window.LuminaLocation : null;
}

function _mountLocationCard(block, card, factoryName) {
    const ui = _locationUi();
    if (!ui || typeof ui[factoryName] !== "function") {
        const warn = document.createElement("div");
        warn.className = "loc-warning";
        warn.textContent = "Konum arayüzü yüklenemedi. Sayfayı yenilemeyi dene.";
        card.appendChild(warn);
        return;
    }
    const node = ui[factoryName](block);
    if (node) card.appendChild(node);
}

function buildSmartLocationResults(block, card) { _mountLocationCard(block, card, "createLocationResults"); }
function buildSmartWeatherForecast(block, card) { _mountLocationCard(block, card, "createWeatherForecast"); }
function buildSmartRouteInfo(block, card) { _mountLocationCard(block, card, "createRouteInfo"); }
function buildSmartLocationRequest(block, card) { _mountLocationCard(block, card, "createLocationRequest"); }
function buildSmartLocationInfo(block, card) { _mountLocationCard(block, card, "createLocationInfo"); }

function renderSmartUI(block, container) {
    if (!block || !block.type || !container) return null;
    const type = String(block.type).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SMART_UI_BUILDERS, type)) return null;
    const builder = SMART_UI_BUILDERS[type];
    const card = document.createElement("div");
    card.className = "smart-ui-card";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", block.title || "İnteraktif araç");
    const header = document.createElement("div");
    header.className = "smart-ui-header";
    header.innerHTML = `
        <span class="smart-ui-title">🧩 ${escapeHTML(block.title || "İnteraktif Araç")}</span>
        <span class="smart-ui-badge">${escapeHTML(SMART_UI_TYPE_LABELS[type] || type)}</span>
    `;
    card.appendChild(header);
    if (block.description) {
        const desc = document.createElement("p");
        desc.style.cssText = "font-size:12px;color:var(--text-secondary);margin:0 0 12px;line-height:1.5;";
        desc.textContent = String(block.description).slice(0, 300);
        card.appendChild(desc);
    }
    try {
        builder(block, card);
    } catch (e) {
        console.debug("Smart UI render hatası:", e);
        return null;
    }
    container.appendChild(card);
    return card;
}

const SMART_UI_TYPE_LABELS = {
    calculator: "Hesap Makinesi",
    task_manager: "Görev Listesi",
    budget_planner: "Bütçe Planlayıcı",
    calendar: "Takvim",
    unit_converter: "Birim Çevirici",
    project_roadmap: "Proje Panosu",
    study_planner: "Ders Programı",
    comparison_table: "Karşılaştırma",
    interactive_form: "İnteraktif Form",
    checklist: "Kontrol Listesi",
    progress_tracker: "İlerleme Takibi",
    data_table: "Veri Tablosu",
    location_results: "Yakın Mekânlar",
    weather_forecast: "Hava Durumu",
    route_info: "Yol Tarifi",
    location_request: "Konum İzni",
    location_info: "Konum Bilgisi"
};

function setSmartContextPrompt(text) {
    const input = document.getElementById("user-input");
    if (input) { input.value = text; input.focus(); }
}

function buildSmartCalculator(block, card) {
    const data = block.data || {};
    const display = document.createElement("div");
    display.className = "smart-calc-display";
    const exprLine = document.createElement("span");
    exprLine.style.cssText = "font-size:12px;color:var(--text-secondary);min-height:16px;display:block;";
    const resultLine = document.createElement("span");
    resultLine.textContent = formatCalcNumber(data.initial_value ?? 0);
    display.appendChild(exprLine);
    display.appendChild(resultLine);

    let expr = String(data.formula || "");
    const keys = ["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "(", ")", "+", "%", "^", "⌫"];
    const grid = document.createElement("div");
    grid.className = "smart-calc-grid";

    const refresh = () => {
        exprLine.textContent = expr;
        if (!expr.trim()) { resultLine.textContent = formatCalcNumber(data.initial_value ?? 0); return; }
        const val = safeCalcExpression(expr);
        resultLine.textContent = val === null ? "Hatalı ifade" : formatCalcNumber(val);
    };

    keys.forEach(k => {
        const btn = document.createElement("button");
        btn.className = `smart-calc-btn ${"+-*/()^.%".includes(k) ? "op-btn" : ""}`;
        btn.textContent = k;
        btn.setAttribute("aria-label", `Tuş ${k}`);
        btn.setAttribute("data-act", "calc-key");
        btn.addEventListener("click", () => {
            if (k === "⌫") expr = expr.slice(0, -1);
            else expr += k;
            refresh();
        });
        grid.appendChild(btn);
    });

    const clearBtn = document.createElement("button");
    clearBtn.className = "smart-calc-btn op-btn";
    clearBtn.textContent = "C";
    clearBtn.setAttribute("data-act", "calc-clear");
    clearBtn.addEventListener("click", () => { expr = ""; refresh(); });
    const eqBtn = document.createElement("button");
    eqBtn.className = "smart-calc-btn eq-btn";
    eqBtn.textContent = "= ve Sohbete Yaz";
    eqBtn.setAttribute("data-act", "calc-eq");
    eqBtn.addEventListener("click", () => {
        const val = safeCalcExpression(expr);
        if (val !== null) setSmartContextPrompt(`Hesap yönlendirici:\n\n${expr} = ${formatCalcNumber(val)}`);
    });
    grid.appendChild(clearBtn);
    grid.appendChild(eqBtn);

    card.appendChild(display);
    card.appendChild(grid);
    refresh();
    return card;
}

function formatCalcNumber(n) {
    if (n === null || n === undefined || n === "") return "0";
    try { return Number(n).toLocaleString("tr-TR", { maximumFractionDigits: 6 }); } catch (e) { return String(n); }
}

function buildSmartTaskManager(block, card) {
    const data = block.data || {};
    const tasks = (Array.isArray(data.tasks) ? data.tasks : []).slice(0, 30);
    const listEl = document.createElement("div");
    listEl.className = "smart-task-list";

    const redraw = () => {
        listEl.innerHTML = "";
        tasks.forEach((t, idx) => {
            const row = document.createElement("div");
            row.className = `smart-task-item ${t.done ? "done" : ""}`;
            row.setAttribute("data-act", "task-item");
            const check = document.createElement("input");
            check.type = "checkbox";
            check.checked = !!t.done;
            check.setAttribute("aria-label", `Görev tamamlandı: ${t.title}`);
            check.addEventListener("change", () => { tasks[idx].done = check.checked; redraw(); });
            const title = document.createElement("span");
            title.style.cssText = "flex:1;word-break:break-word;";
            title.textContent = t.title || "Görev";
            const prio = document.createElement("span");
            if (t.priority) prio.textContent = `• ${t.priority}`;
            prio.style.cssText = "font-size:10px;color:var(--text-muted);";
            row.appendChild(check);
            row.appendChild(title);
            row.appendChild(prio);
            listEl.appendChild(row);
        });
        if (!tasks.length) listEl.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">Görev yok.</span>`;
    };
    redraw();

    const addRow = document.createElement("div");
    addRow.className = "smart-task-add-row";
    const input = document.createElement("input");
    input.className = "smart-task-input";
    input.placeholder = "Yeni görev ekle...";
    input.setAttribute("data-act", "task-input");
    const addBtn = document.createElement("button");
    addBtn.className = "modal-action-btn";
    addBtn.style.cssText = "width:auto;padding:8px 14px;";
    addBtn.textContent = "Ekle";
    addBtn.setAttribute("data-act", "task-add");
    addBtn.addEventListener("click", () => {
        const v = (input.value || "").trim().slice(0, 160);
        if (!v) return;
        const id = String(tasks.length + 1);
        tasks.push({ id, title: v, done: false });
        input.value = "";
        redraw();
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addBtn.click(); } });
    addRow.appendChild(input);
    addRow.appendChild(addBtn);

    const sendBtn = buildSendToChatBtn(() => {
        const lines = tasks.map(t => `- [${t.done ? "x" : " "}] ${t.title}`);
        return `Görev listemi güncel tutmamı sağla:\n\n${lines.join("\n")}`;
    });

    card.appendChild(listEl);
    card.appendChild(addRow);
    card.appendChild(buildActionBar(sendBtn));
    return card;
}

function buildSmartBudgetPlanner(block, card) {
    const data = block.data || {};
    const currency = String(data.currency || "TL");
    const income = Number(data.income || 0);
    const expenses = (Array.isArray(data.expenses) ? data.expenses : []).slice(0, 25);

    const totalExp = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const remaining = income - totalExp;
    const pct = (income > 0) ? Math.min(999, Math.round((totalExp / income) * 100)) : 0;

    const summary = document.createElement("div");
    summary.className = "smart-budget-summary";
    const mk = (label, value, color) => {
        const stat = document.createElement("div");
        stat.className = "smart-budget-stat";
        const labelEl = document.createElement("div");
        labelEl.className = "smart-budget-label";
        labelEl.textContent = label;
        const valEl = document.createElement("div");
        valEl.className = "smart-budget-val";
        if (color) valEl.style.color = color;
        valEl.textContent = `${formatTRNumber(value)} ${currency}`;
        stat.appendChild(labelEl);
        stat.appendChild(valEl);
        return stat;
    };
    summary.appendChild(mk("Gelir", income, "#22c55e"));
    summary.appendChild(mk("Gider", totalExp, "#ef4444"));
    summary.appendChild(mk("Kalan", remaining, remaining >= 0 ? "#22c55e" : "#ef4444"));
    const bar = document.createElement("div");
    bar.style.cssText = "height:6px;background:var(--bg-base);border-radius:4px;overflow:hidden;margin-bottom:12px;";
    bar.innerHTML = `<div style="height:100%;width:${Math.min(100, pct)}%;background:${pct > 90 ? "#ef4444" : pct > 70 ? "#f59e0b" : "#22c55e"};border-radius:4px;"></div>`;

    const listEl = document.createElement("ul");
    listEl.style.cssText = "list-style:none;display:flex;flex-direction:column;gap:6px;margin:0 0 12px;padding:0;font-size:12.5px;";
    expenses.forEach(e => {
        const li = document.createElement("li");
        li.textContent = `${e.title || "Gider"} — ${formatTRNumber(e.amount)} ${currency} (${e.category || "Genel"})`;
        listEl.appendChild(li);
    });

    const sendBtn = buildSendToChatBtn(() => {
        const lines = expenses.map(e => `- ${e.title}: ${formatTRNumber(e.amount)} ${currency} (${e.category || "Genel"})`);
        return `Bütçeme bakarken tasarruf önerilerini çıkar:\n\nGelir: ${formatTRNumber(income)} ${currency}\nGiderler:\n${lines.join("\n")}\n\nKalan: ${formatTRNumber(remaining)} ${currency}`;
    });
    card.appendChild(summary);
    card.appendChild(bar);
    card.appendChild(listEl);
    card.appendChild(buildActionBar(sendBtn));
    return card;
}

function buildSmartCalendar(block, card) {
    const data = block.data || {};
    const events = (Array.isArray(data.events) ? data.events : []).slice(0, 20);
    const today = new Date().toISOString().slice(0, 10);
    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:6px;";
    events
        .slice()
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .forEach(e => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;";
            const isToday = e.date === today;
            row.innerHTML = `
                <span style="font-weight:700;min-width:86px;">${escapeHTML(e.date || "")}</span>
                <span style="flex:1;">${escapeHTML(e.title || "Etkinlik")}</span>
                ${e.time ? `<span>${escapeHTML(e.time)}</span>` : ""}
            `;
            if (isToday) row.style.borderColor = "var(--accent)";
            list.appendChild(row);
        });
    if (!events.length) list.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">Etkinlik yok.</span>`;
    card.appendChild(list);
    return card;
}

const SMART_UNIT_CATEGORIES = {
    length: { units: { metre: 1, kilometre: 1000, santimetre: 0.01, milimetre: 0.001, feet: 0.3048, inch: 0.0254, mile: 1609.34 } },
    mass: { units: { gram: 1, kilogram: 1000, ton: 1000000, pound: 453.592, ounce: 28.3495 } },
    time: { units: { saniye: 1, dakika: 60, saat: 3600, gün: 86400, hafta: 604800 } },
    volume: { units: { litre: 1, mililitre: 0.001, metrekup: 1000, galon: 3.78541 } },
    data: { units: { kilobyte: 1024, megabyte: 1048576, gigabyte: 1073741824, terabyte: 1099511627776 } }
};

function buildSmartUnitConverter(block, card) {
    const data = block.data || {};
    let category = String(data.category || "length").toLowerCase();
    if (!SMART_UNIT_CATEGORIES[category]) category = "length";
    const units = SMART_UNIT_CATEGORIES[category].units;
    const unitNames = Object.keys(units);

    const fromSelect = document.createElement("select");
    fromSelect.style.cssText = "flex:1;padding:8px;border-radius:8px;background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);";
    const toSelect = fromSelect.cloneNode(false);
    let valueInput = document.createElement("input");
    valueInput.type = "number";
    valueInput.step = "any";
    valueInput.style.cssText = "flex:1;padding:8px;border-radius:8px;background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);";
    valueInput.value = String(Number(data.value ?? 1));

    const findDefault = (target) => {
        const want = String(data[target] || "").toLowerCase();
        return unitNames.find(u => u.toLowerCase() === want) || unitNames[1] || unitNames[0];
    };
    fromSelect.value = findDefault("from_unit");
    toSelect.value = findDefault("to_unit");

    const fill = (sel) => { unitNames.forEach(u => { const opt = document.createElement("option"); opt.value = u; opt.textContent = u; sel.appendChild(opt); }); };
    fill(fromSelect); fill(toSelect);

    const result = document.createElement("div");
    result.style.cssText = "margin-top:10px;font-size:15px;font-weight:700;";
    const row1 = document.createElement("div");
    row1.style.cssText = "display:flex;gap:8px;align-items:center;";
    row1.appendChild(valueInput); row1.appendChild(fromSelect);
    const arrow = document.createElement("span");
    arrow.textContent = "→";
    const row2 = document.createElement("div");
    row2.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;";
    row2.appendChild(toSelect); row2.appendChild(arrow);

    const calc = () => {
        const v = parseFloat(valueInput.value);
        if (isNaN(v)) { result.textContent = "Bir sayı gir."; return; }
        const out = v * (units[fromSelect.value] || 1) / (units[toSelect.value] || 1);
        result.textContent = `${formatCalcNumber(v)} ${fromSelect.value} = ${formatCalcNumber(Math.round(out * 1e6) / 1e6)} ${toSelect.value}`;
    };
    [valueInput, fromSelect, toSelect].forEach(el => el.addEventListener("input", calc));
    calc();
    card.appendChild(row1);
    card.appendChild(row2);
    card.appendChild(result);
    return card;
}

function buildSmartRoadmap(block, card) {
    const data = block.data || {};
    let phases = Array.isArray(data.phases) ? data.phases.slice(0, 12) : [];
    if (!phases.length && typeof data === "object") {
        // Fallback: { "Faz 1": {...}, "Faz 2": {..} }
        phases = Object.entries(data).slice(0, 10).map(([, v]) => {
            if (v && typeof v === "object") return { title: v.title || v.name || (v.phase ?? "Faz"), status: v.status, progress: Number(v.progress ?? 0), tasks: Array.isArray(v.tasks) ? v.tasks : [] };
            return { title: String(v).slice(0, 120), status: "", progress: null, tasks: [] };
        });
    }
    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:10px;";
    phases.forEach(ph => {
        const wrap = document.createElement("div");
        wrap.style.cssText = "background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:10px 12px;";
        const head = document.createElement("div");
        head.style.cssText = "display:flex;justify-content:space-between;font-size:13px;font-weight:700;";
        head.innerHTML = `<span>${escapeHTML(String(ph.title || ph.phase || ph.name || "Faz"))}</span><span style="font-weight:600;color:var(--text-secondary);font-size:11.5px;">${escapeHTML(String(ph.status || ""))}</span>`;
        wrap.appendChild(head);
        if (ph.progress != null && !isNaN(Number(ph.progress))) {
            const p = Math.max(0, Math.min(100, Number(ph.progress)));
            const bar = document.createElement("div");
            bar.style.cssText = "height:5px;background:var(--bg-base);border-radius:4px;overflow:hidden;margin-top:8px;";
            bar.innerHTML = `<div style="height:100%;width:${p}%;background:var(--accent);border-radius:4px;"></div>`;
            wrap.appendChild(bar);
        }
        if (Array.isArray(ph.tasks) && ph.tasks.length) {
            const ul = document.createElement("ul");
            ul.style.cssText = "margin:8px 0 0 0;padding-left:16px;font-size:12px;color:var(--text-secondary);";
            ph.tasks.slice(0, 6).forEach(t => { const li = document.createElement("li"); li.textContent = (t && t.title) ? String(t.title) : String(t); ul.appendChild(li); });
            wrap.appendChild(ul);
        }
        list.appendChild(wrap);
    });
    card.appendChild(list);
    return card;
}

function buildSmartStudyPlanner(block, card) {
    const data = block.data || {};
    const schedule = (Array.isArray(data.schedule) ? data.schedule : []).slice(0, 25);
    const list = document.createElement("div");
    list.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;";
    schedule.forEach(s => {
        const day = document.createElement("div");
        day.style.cssText = "background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:10px;";
        day.innerHTML = `
            <div style="font-size:12px;font-weight:700;margin-bottom:4px;">📅 ${escapeHTML(String(s.day || ""))}</div>
            <div style="font-size:12.5px;">${escapeHTML(String(s.subject || "Ders"))}</div>
            ${s.duration ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">⏱ ${escapeHTML(String(s.duration))}</div>` : ""}
        `;
        list.appendChild(day);
    });
    if (!schedule.length) list.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">Program yok.</span>`;
    card.appendChild(list);
    return card;
}

function buildSmartComparisonTable(block, card) {
    const data = block.data || {};
    const headers = (Array.isArray(data.headers) ? data.headers : []).slice(0, 6);
    const rows = (Array.isArray(data.rows) ? data.rows : []).slice(0, 25);
    if (!headers.length || !rows.length) { card.appendChild(document.createTextNode("")); return card; }
    const wrapper = document.createElement("div");
    wrapper.className = "comparison-wrapper";
    let html = "<table class=\"comparison-table\"><thead><tr>";
    html += headers.map(h => `<th>${escapeHTML(String(h))}</th>`).join("") + "</tr></thead><tbody>";
    rows.forEach(r => {
        if (!Array.isArray(r)) return;
        html += "<tr>" + r.slice(0, headers.length).map(c => `<td>${escapeHTML(c == null ? "" : String(c))}</td>`).join("") + "</tr>";
    });
    html += "</tbody></table>";
    wrapper.innerHTML = html;
    card.appendChild(wrapper);
    return card;
}

function buildSmartInteractiveForm(block, card) {
    const data = block.data || {};
    const fields = (Array.isArray(data.fields) ? data.fields : []).slice(0, 15);
    const form = document.createElement("div");
    form.style.cssText = "display:flex;flex-direction:column;gap:10px;";
    const inputs = [];
    fields.forEach(f => {
        if (!f || !f.name) return;
        const wrap = document.createElement("div");
        const label = document.createElement("label");
        label.style.cssText = "font-size:11.5px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px;";
        label.textContent = (f.label || f.name) + (f.required ? " *" : "");
        let control;
        if (String(f.type) === "select" || Array.isArray(f.options)) {
            control = document.createElement("select");
            control.style.cssText = "width:100%;padding:8px;border-radius:8px;background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);";
            (Array.isArray(f.options) ? f.options : [f.options]).filter(Boolean).forEach(o => {
                const opt = document.createElement("option");
                opt.value = String(o); opt.textContent = String(o);
                control.appendChild(opt);
            });
        } else if (String(f.type) === "textarea") {
            control = document.createElement("textarea");
            control.rows = 3;
            control.style.cssText = "width:100%;padding:8px;border-radius:8px;background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);resize:vertical;";
        } else {
            control = document.createElement("input");
            control.type = ["number", "email", "date", "tel", "password"].includes(String(f.type)) ? String(f.type) : "text";
            control.style.cssText = "width:100%;padding:8px;border-radius:8px;background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);";
            if (f.min != null) control.min = f.min;
            if (f.max != null) control.max = f.max;
        }
        control.setAttribute("data-act", "form-field");
        control.setAttribute("aria-label", f.label || f.name);
        wrap.appendChild(label);
        wrap.appendChild(control);
        form.appendChild(wrap);
        inputs.push({ def: f, control });
    });

    const submit = document.createElement("button");
    submit.className = "modal-action-btn";
    submit.setAttribute("data-act", "form-submit");
    submit.textContent = "Formu Gönder (Sohbete Yaz)";
    submit.addEventListener("click", () => {
        const lines = inputs.map(({ def, control }) => `${def.label || def.name}: ${String(control.value || "-").slice(0, 160)}`);
        setSmartContextPrompt(`Form yanıtım:\n\n${lines.join("\n")}`);
    });

    card.appendChild(form);
    card.appendChild(submit);
    return card;
}

function buildSmartChecklist(block, card) {
    const data = block.data || {};
    const items = (Array.isArray(data.items) ? data.items : []).slice(0, 80).map(it => ({
        text: String((it && it.text) || "").slice(0, 200),
        done: !!(it && it.done)
    }));

    const progress = document.createElement("div");
    progress.className = "smart-checklist-progress";
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-live", "polite");

    const list = document.createElement("div");
    list.className = "smart-checklist";

    const redraw = () => {
        list.innerHTML = "";
        items.forEach((item, idx) => {
            const row = document.createElement("label");
            row.className = `smart-checklist-item ${item.done ? "done" : ""}`;
            const check = document.createElement("input");
            check.type = "checkbox";
            check.checked = item.done;
            check.setAttribute("aria-label", `Tamamlandı: ${item.text || "Madde"}`);
            check.addEventListener("change", () => {
                items[idx].done = check.checked;
                redraw();
            });
            const span = document.createElement("span");
            span.textContent = item.text || "Madde";
            row.appendChild(check);
            row.appendChild(span);
            list.appendChild(row);
        });
        if (!items.length) {
            const empty = document.createElement("span");
            empty.style.cssText = "font-size:12px;color:var(--text-muted);";
            empty.textContent = "Liste boş.";
            list.appendChild(empty);
        }
        const doneCount = items.filter(i => i.done).length;
        progress.textContent = `${doneCount}/${items.length} tamamlandı`;
    };
    redraw();

    const sendBtn = buildSendToChatBtn(() => {
        const lines = items.map(i => `- [${i.done ? "x" : " "}] ${i.text}`);
        return `Kontrol listemi gözden geçir ve eksikleri hatırlat:\n\n${lines.join("\n")}`;
    });

    card.appendChild(progress);
    card.appendChild(list);
    card.appendChild(buildActionBar(sendBtn));
    return card;
}

function buildSmartProgressTracker(block, card) {
    const data = block.data || {};
    const goals = (Array.isArray(data.goals) ? data.goals : []).slice(0, 30).map(g => {
        const target = Number(g && g.target);
        const current = Number(g && g.current);
        return {
            label: String((g && g.label) || "Hedef").slice(0, 160),
            current: Number.isFinite(current) ? Math.max(0, current) : 0,
            target: Number.isFinite(target) && target > 0 ? target : 1,
            unit: g && g.unit ? String(g.unit).slice(0, 24) : ""
        };
    });

    const list = document.createElement("div");
    list.className = "smart-progress-list";
    goals.forEach(goal => {
        const pct = Math.max(0, Math.min(100, Math.round((goal.current / goal.target) * 100)));
        const wrap = document.createElement("div");
        wrap.className = "smart-progress-goal";

        const head = document.createElement("div");
        head.className = "smart-progress-head";
        const label = document.createElement("span");
        label.textContent = goal.label;
        const pctLabel = document.createElement("span");
        pctLabel.textContent = `%${pct}`;
        head.appendChild(label);
        head.appendChild(pctLabel);

        const bar = document.createElement("div");
        bar.className = "smart-progress-bar";
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-label", goal.label);
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        bar.setAttribute("aria-valuenow", String(pct));
        const fill = document.createElement("div");
        fill.className = "smart-progress-fill";
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);

        const detail = document.createElement("div");
        detail.className = "smart-progress-detail";
        detail.textContent = `${formatTRNumber(goal.current)} / ${formatTRNumber(goal.target)}${goal.unit ? ` ${goal.unit}` : ""}`;

        wrap.appendChild(head);
        wrap.appendChild(bar);
        wrap.appendChild(detail);
        list.appendChild(wrap);
    });

    if (!goals.length) {
        const empty = document.createElement("span");
        empty.style.cssText = "font-size:12px;color:var(--text-muted);";
        empty.textContent = "Hedef yok.";
        list.appendChild(empty);
    }

    const sendBtn = buildSendToChatBtn(() => {
        const lines = goals.map(g => `- ${g.label}: ${formatTRNumber(g.current)} / ${formatTRNumber(g.target)}${g.unit ? ` ${g.unit}` : ""}`);
        return `İlerlememi değerlendir ve sonraki adımları öner:\n\n${lines.join("\n")}`;
    });

    card.appendChild(list);
    card.appendChild(buildActionBar(sendBtn));
    return card;
}

function buildSmartDataTable(block, card) {
    const data = block.data || {};
    const columns = (Array.isArray(data.columns) ? data.columns : []).slice(0, 10);
    const rows = (Array.isArray(data.rows) ? data.rows : []).slice(0, 150);
    if (!columns.length) return card;

    if (data.caption) {
        const caption = document.createElement("p");
        caption.className = "smart-data-caption";
        caption.textContent = String(data.caption).slice(0, 200);
        card.appendChild(caption);
    }

    const wrapper = document.createElement("div");
    wrapper.className = "data-table-wrapper";
    const table = document.createElement("table");
    table.className = "comparison-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    columns.forEach(col => {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = String(col ?? "").slice(0, 120);
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    rows.forEach(row => {
        if (!Array.isArray(row)) return;
        const tr = document.createElement("tr");
        columns.forEach((_col, idx) => {
            const td = document.createElement("td");
            td.textContent = String(row[idx] ?? "").slice(0, 300);
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    card.appendChild(wrapper);
    return card;
}

function buildSendToChatBtn(getPrompt) {
    const btn = document.createElement("button");
    btn.className = "smart-ui-send-chat-btn";
    btn.setAttribute("data-act", "smart-send");
    btn.textContent = "↥ Sohbete Öndoldur";
    btn.addEventListener("click", () => setSmartContextPrompt(getPrompt()));
    return btn;
}

function buildActionBar(...children) {
    const bar = document.createElement("div");
    bar.className = "smart-ui-action-bar";
    children.filter(Boolean).forEach(c => bar.appendChild(c));
    return bar;
}


// ============================================================
// 20. CANLI AKIŞ (STREAMING + STOP)
// ayarlar'daki "Canlı akış" tercihi açıkken kullanılır.
// ============================================================

let activeStreamController = null;
let streamingActive = false;

function setSendButtonStreaming(isStreaming) {
    const btn = document.getElementById("send-btn");
    if (!btn) return;
    if (isStreaming) {
        btn.textContent = "⏹";
        btn.title = "Durdur (veya Esc)";
        btn.setAttribute("data-act", "stream-stop");
        btn.onclick = stopStreaming;
    } else {
        btn.textContent = "➤";
        btn.title = "Gönder";
        btn.removeAttribute("data-act");
        btn.onclick = sendMessage;
    }
}

function stopStreaming() {
    if (activeStreamController) {
        try { activeStreamController.abort(); } catch (e) {}
    }
}

async function tryStreamingSend(text, agentMode, sid) {
    if (!hasBackend()) return false;
    if (!window.AbortController || typeof ReadableStream === "undefined") return false;
    if (chatBusy()) return false;

    activeStreamController = new AbortController();
    setSendButtonStreaming(true);
    streamingActive = true;

    // Streaming baloncuğu oluşturulur
    hideTypingIndicator();
    removeStarterHero();
    const stream = document.getElementById("chat-stream");
    if (!stream) { setSendButtonStreaming(false); streamingActive = false; return false; }

    const row = document.createElement("div");
    row.className = "message-row bot-row";
    const title = AGENT_TITLES[agentMode] || "Lumina AI";
    row.innerHTML = `
        <div class="msg-meta"><strong>${title}</strong> • canlı akış</div>
        <div class="message-bubble bot-bubble" id="streaming-bubble"><span style="opacity:0.6;">…</span></div>
    `;
    stream.appendChild(row);
    const bubble = row.querySelector("#streaming-bubble");
    scrollToBottom();

    let aborted = false;
    let fullText = "";
    const onAbort = () => { aborted = true; };
    activeStreamController.signal.addEventListener("abort", onAbort);
    const onEsc = (e) => { if (e.key === "Escape") stopStreaming(); };
    document.addEventListener("keydown", onEsc);

    try {
        const token = await getAuthToken();
        const res = await fetch(`${backendUrl}/chat/stream`, {
            method: "POST",
            signal: activeStreamController.signal,
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({
                message: text,
                agent_mode: agentMode,
                custom_groq_key: directGroqKey || directGitHubToken || null,
                personality: currentPersonality,
                attached_document: currentAttachedDoc ? {
                    filename: currentAttachedDoc.filename,
                    excerpt: currentAttachedDoc.excerpt || currentAttachedDoc.preview || ""
                } : null,
                conversation_id: String(currentSessionId || "default").slice(0, 64),
                location: getChatLocationPayload(),
                ...getClientTimeContext()
            })
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            row.remove();
            setSendButtonStreaming(false);
            streamingActive = false;
            if (res.status === 403) showQuotaExceededModal("message");
            else deliverBotMessage(sid, `⚠️ ${detailText(data.detail)}`, agentMode);
            stopKeepAliveIfIdle();
            return true; // hata iletildi; klasik akışa düşmeye gerek yok
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let finalData = {};
        let sawDone = false;

        const parseSSELines = (blockText) => {
            blockText.split("\n\n").forEach((part) => {
                const line = part.split("\n").find(l => l.startsWith("data: "));
                if (!line) return;
                try {
                    const payload = JSON.parse(line.slice(6));
                    if (payload.chunk) {
                        fullText += payload.chunk;
                    } else if (payload.done) {
                        sawDone = true;
                        finalData = payload;
                    } else if (payload.error) {
                        finalData.error = payload.error;
                    }
                } catch (e) { /* parça tamamlanmamış olabilir */ }
            });
        };

        let lastPaint = 0;
        const paint = (force) => {
            const now = Date.now();
            if (!force && now - lastPaint < 120) return;
            lastPaint = now;
            const clean = stripClientSmartUI(fullText) || "";
            bubble.innerHTML = formatMarkdownAndCode(clean || "…");
            scrollToBottom();
        };

        while (true) {
            if (aborted && !sawDone) { try { reader.cancel(); } catch (e) {} break; }
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n\n")) >= 0) {
                const block = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                parseSSELines(block + "\n\n");
            }
            paint(false);
        }
        if (buffer) parseSSELines(buffer);

        // Final render: blokları ayıkla, tek kayıtla oturuma ekle, akış balonunu sabitle
        row.remove();
        const parsedClient = parseClientSmartUIBlocks(fullText);
        const cleanText = parsedClient.clean || fullText;
        // Güvenilir sunucu yanıtındaki bloklar (finalData.smart_ui) sunucu
        // taraflı tipleri içerebilir; model metninden gelenler içeremez.
        const serverBlocks = Array.isArray(finalData.smart_ui) && finalData.smart_ui.length
            ? finalData.smart_ui.map(b => sanitizeClientSmartBlock(b, { allowServerOnly: true })).filter(Boolean)
            : parsedClient.blocks.map(b => sanitizeClientSmartBlock(b)).filter(Boolean);
        deliverBotMessage(sid, cleanText, agentMode, {
            smartUI: serverBlocks,
            modelUsed: finalData.model_used || ""
        });
        if (finalData.quota) updateQuotaDisplay(finalData.quota);
        if (finalData.error) showToast("Akış Yarıda Kesildi", finalData.error, null, 7000);
        if (!document.hidden && sid === currentSessionId && cleanText) speakText(cleanText.slice(0, 400));
        if (sid !== currentSessionId) notifyIfAway("Lumina cevapladı 💬", snippet(cleanText), sid, "lumina-chat");

        setSendButtonStreaming(false);
        streamingActive = false;
        stopKeepAliveIfIdle();
        return true;

    } catch (errAbort) {
        // AbortError beklenen bir durumdur; diğer hatalarda klasik job akışına düşülür
        row.remove();
        setSendButtonStreaming(false);
        streamingActive = false;
        activeStreamController = null;
        if (aborted) {
            const partial = stripClientSmartUI(fullText || "");
            if (partial) {
                const p = parseClientSmartUIBlocks(fullText || "");
                deliverBotMessage(sid, partial + "\n\n*(⏹ akış bu noktada durduruldu.)*", agentMode, {
                    smartUI: p.blocks.map(b => sanitizeClientSmartBlock(b)).filter(Boolean)
                });
            } else {
                deliverBotMessage(sid, "⏹ Akış durduruldu.", agentMode);
            }
            stopKeepAliveIfIdle();
            return true;
        }
        return false; // ağ hatası → klasik job akışına geri dön
    } finally {
        document.removeEventListener("keydown", onEsc);
        if (activeStreamController && activeStreamController.signal.removeEventListener) {
            activeStreamController.signal.removeEventListener("abort", onAbort);
        }
    }
}

function sessionStillExists() {
    // Oturum hâlâ var mı? (silinmediyse ve sonradan render edilecekse true)
    return sessions.some(s => s.id === currentSessionId);
}

function sanitizeClientSmartBlock(block, options) {
    // Smart UI bloğu backend'de doğrulanır; frontend son savunma hattı olarak
    // yalnızca bilinen tipleri kabul eder ve beklenen alanları sınırlar.
    //
    // Canlı konum/hava/rota blokları YALNIZCA güvenilir sunucu yanıtından
    // kabul edilir. Model çıktısından gelen aynı tipler (doğrudan Groq modu)
    // reddedilir; böylece model koordinat/işletme/hava uyduramaz.
    if (!block || typeof block !== "object") return null;
    const allowServerOnly = Boolean(options && options.allowServerOnly);
    const type = String(block.type || "").toLowerCase().slice(0, 40);
    if (!Object.prototype.hasOwnProperty.call(SMART_UI_BUILDERS, type)) return null;
    if (!allowServerOnly && SERVER_ONLY_UI_TYPES.has(type)) return null;
    return {
        type: type,
        title: String(block.title || "").slice(0, 120),
        description: block.description == null ? null : String(block.description).slice(0, 300),
        data: (block.data && typeof block.data === "object") ? block.data : {}
    };
}


// ============================================================
// 21. HESAP GELİŞTİRMELERİ (DOĞRULAMA & SİLME)
// ============================================================

function updateAccountStatusPhone() {
    const box = document.getElementById("account-status");
    if (!box) return;
    if (isFirebaseActive && auth && auth.currentUser && auth.currentUser.email) {
        const verified = auth.currentUser.emailVerified ? "✅ doğrulanmış" : "⚠️ doğrulanmamış";
        box.textContent = `Girişli: ${auth.currentUser.email} — e-posta ${verified}`;
    } else {
        box.textContent = "Misafir modundasın; hesap işlemleri Firebase ile giriş yapan kullanıcılar için geçerlidir.";
    }
}

async function resendVerificationEmail() {
    if (!isFirebaseActive || !auth || !auth.currentUser) {
        showToast("Hesap Bulunamadı", "Doğrulama e-postası için giriş yapmış bir hesap gerekir.", null, 7000);
        return;
    }
    try {
        await auth.currentUser.sendEmailVerification();
        showToast("Doğrulama E-postası Gönderildi", `Kutunu kontrol et: ${auth.currentUser.email}`);
        updateAccountStatusPhone();
    } catch (e) {
        showToast("Gönderilemedi", detailText(translateAuthError(e)), null, 8000);
    }
}

async function handleDeleteAccount() {
    if (!isFirebaseActive || !auth || !auth.currentUser) {
        showToast("Hesap Bulunamadı", "Firebase ile giriş yapan kullanıcı hesabı silinebilir.", null, 7000);
        return;
    }
    const first = confirm("⚠️ Hesabın kalıcı olarak silinecek. Bu işlem GERİ ALINAMAZ. Devam edilsin mi?");
    if (!first) return;
    const second = confirm("Son onay: e-posta + verilerin kalıcı silinecek. Onaylıyor musun?");
    if (!second) return;
    try {
        await auth.currentUser.delete();
        currentUser = null;
        isGuestMode = true;
        updateUserDisplay("Misafir Modu");
        showToast("Hesap Silindi", "Hesabın Firebase Authentication'dan tamamen kaldırıldı.");
        updateAccountStatusPhone();
        fetchAndDisplayQuota();
    } catch (e) {
        showToast("Sililemedi", translateAuthError(e), null, 9000);
    }
}

// translateAuthError hatalarına ek çeviri listesi:
(function extendAuthErrorTranslations() {
    const extra = {
        "auth/invalid-credential": "E-posta veya şifre hatalı. Lütfen kontrol edip tekrar deneyin.",
        "auth/email-not-verified": "E-posta doğrulaması yapılmadı, işlem onaylanmaz.",
        "auth/operation-not-allowed": "Bu işlem şu anda kapalı; yönetici ayarları makçısıyla açılabilir.",
        "auth/requires-recent-login": "Güvenlik için yeniden giriş yapmanız gerekiyor. Çıkış yapıp tekrar giriş sağlayın.",
        "auth/account-exists-with-different-credential": "Bu e-posta zaten farklı bir yöntemle kayıtlı; o yöntemle giriş yapmayı deneyin."
    };
    const orig = translateAuthError;
    translateAuthError = function (err) {
        if (err && err.code && extra[err.code]) return extra[err.code];
        return orig(err);
    };
})();
