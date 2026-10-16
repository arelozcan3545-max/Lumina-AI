// ============================================================
// LUMINA AI - CLIENT APPLICATION ENGINE (APP.JS v2.2)
// Fullscreen Fluid Architecture + Local Multi-Chat History
// GitHub Pages Serverless Mode (Direct Groq) + Backend Fallback
// ============================================================

// ============================================================
// 1. CONFIGURATION & STATE
// ============================================================

// Kendi backend'inizi bir sunucuya (Render/Railway/VPS vb.) dağıttıysanız
// adresini buraya girin. Boş bırakılırsa: yerelde (localhost) çalışırken
// otomatik olarak 127.0.0.1:8000 kullanılır; canlı bir domainde (ör. GitHub
// Pages) ise backend adresi bilinmediğinden kullanıcı Ayarlar menüsünden
// kendi Groq API anahtarını girene kadar sunucusuz mod kullanılır. Bu ayrım
// olmadan önceki sürüm, canlıdaki HERKESİ otomatik olarak "önce localhost'a
// bağlanmayı dene, o da olmazsa anahtar iste" akışına sokuyordu — bu yüzden
// gerçek ziyaretçiler için dahili kota hiç devreye girmiyordu.
const DEPLOYED_BACKEND_URL = ""; // örn: "https://lumina-backend.onrender.com/api/v1"

function resolveDefaultBackendUrl() {
    const isLocalHost = ["localhost", "127.0.0.1", ""].includes(window.location.hostname) ||
        window.location.protocol === "file:";
    if (isLocalHost) return "http://127.0.0.1:8000/api/v1";
    return DEPLOYED_BACKEND_URL || "http://127.0.0.1:8000/api/v1";
}

let backendUrl = localStorage.getItem("lumina_backend_url") || resolveDefaultBackendUrl();
let directGeminiKey = localStorage.getItem("lumina_direct_gemini_key") || "";
let directGroqKey = localStorage.getItem("lumina_direct_groq_key") || "";
let directGitHubToken = localStorage.getItem("lumina_github_token") || "";

// Config.js & GitHub Variables Otomatik Algılama
if (typeof window !== "undefined") {
    if (window.LUMINA_CONFIG) {
        if (!directGeminiKey && window.LUMINA_CONFIG.GEMINI_API_KEY) directGeminiKey = window.LUMINA_CONFIG.GEMINI_API_KEY;
        if (!directGroqKey && window.LUMINA_CONFIG.GROQ_API_KEY) directGroqKey = window.LUMINA_CONFIG.GROQ_API_KEY;
        if (!directGitHubToken && window.LUMINA_CONFIG.GITHUB_TOKEN) directGitHubToken = window.LUMINA_CONFIG.GITHUB_TOKEN;
        if (!localStorage.getItem("lumina_backend_url") && window.LUMINA_CONFIG.BACKEND_URL) backendUrl = window.LUMINA_CONFIG.BACKEND_URL;
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
// KALICI MİSAFİR KİMLİĞİ (GÜÇLÜ HAFIZA İÇİN)
// ============================================================
function getGuestId() {
    let id = localStorage.getItem("lumina_guest_id");
    if (!id) {
        const raw = (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
        id = `guest_${raw.replace(/[^A-Za-z0-9\-]/g, "").slice(0, 48)}`;
        localStorage.setItem("lumina_guest_id", id);
    }
    return id;
}

async function getAuthToken() {
    return (isFirebaseActive && auth && auth.currentUser)
        ? await auth.currentUser.getIdToken()
        : getGuestId();
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

    if (isFirebaseActive && auth) {
        auth.onAuthStateChanged((user) => {
            if (user) {
                currentUser = user;
                isGuestMode = false;
                updateUserDisplay(user.displayName || user.email);
                fetchAndDisplayQuota();
                fetchSubscriptionDetails();
                updateAccountStatusPhone();
                if (!user.emailVerified && user.email) {
                    showToast("E-posta Doğrulaması", "Hesabını güvenceye almak için e-postani doğrula (Ayarlar → yeniden gönder).");
                }
            } else {
                currentUser = null;
                isGuestMode = true;
                updateUserDisplay("Misafir Modu");
                fetchAndDisplayQuota();
            }
        });
    } else {
        updateUserDisplay("Misafir Modu");
        fetchAndDisplayQuota();
    }
});

function updateUserDisplay(name) {
    const label = document.getElementById("sidebar-user-name");
    if (label) label.innerText = name;
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
    try {
        const token = await getAuthToken();
        const res = await fetch(`${backendUrl}/memory`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${token}` }
        });
        serverOk = res.ok;
    } catch (e) { /* backend yok */ }
    showToast("Hafıza sıfırlandı", serverOk
        ? "Lumina seni baştan tanıyacak."
        : "Bu cihazdaki hafıza silindi. (Sunucuya ulaşılamadı.)");
    fetchAndDisplayMemory();
}

// Fetch quota from backend and update UI
async function fetchAndDisplayQuota() {
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
    }
};

function selectPersonality(type) {
    if (!PERSONALITY_DESCRIPTIONS[type]) type = "standard";
    currentPersonality = type;
    localStorage.setItem("lumina_personality", type);

    document.querySelectorAll(".personality-card").forEach(el => {
        el.classList.toggle("active", el.dataset.personality === type);
    });

    showToast("Kişilik Güncellendi", `${PERSONALITY_DESCRIPTIONS[type].title} aktif edildi.`);
}

// ============================================================
// SES PROFİLLERİ (JENNA, TOMMY VB.)
// ============================================================

const VOICE_PROFILES = {
    "jenna": {
        name: "Jenna",
        gender: "female",
        pitch: 1.14,
        rate: 1.0,
        preferredVoices: ["jenny", "zira", "emel", "yelda", "filiz", "samantha", "victoria", "kız", "female"],
        previewText: "Merhaba! Ben Jenna. Seninle konuşmaktan mutluluk duyuyorum, ne öğrenmek istersin?"
    },
    "emma": {
        name: "Emma",
        gender: "female",
        pitch: 1.04,
        rate: 0.94,
        preferredVoices: ["samantha", "karen", "emel", "zira", "female"],
        previewText: "Selam! Ben Emma. Sakin ve huzurlu bir sohbet için buradayım. Aklındakileri benimle paylaşabilirsin."
    },
    "elif": {
        name: "Elif",
        gender: "female",
        pitch: 1.1,
        rate: 1.0,
        preferredVoices: ["emel", "yelda", "filiz", "tr-tr", "turkish", "female"],
        previewText: "Merhaba, ben Elif! Türkçe sorularını yanıtlamaktan ve birlikte çalışmaktan keyif alırım."
    },
    "tommy": {
        name: "Tommy",
        gender: "male",
        pitch: 0.88,
        rate: 1.02,
        preferredVoices: ["guy", "david", "mark", "tolga", "baris", "male"],
        previewText: "Selam dostum! Ben Tommy. Hızlı, dinamik ve net çözümler için hazırım. Ne üzerinde çalışıyoruz?"
    },
    "david": {
        name: "David",
        gender: "male",
        pitch: 0.78,
        rate: 0.95,
        preferredVoices: ["david", "george", "tolga", "male"],
        previewText: "İyi günler. Ben David. Mantık, analiz ve strateji konularında sana rehberlik etmek için yanındayım."
    },
    "baris": {
        name: "Barış",
        gender: "male",
        pitch: 0.86,
        rate: 1.0,
        preferredVoices: ["tolga", "tr-tr", "turkish", "male"],
        previewText: "Selam! Ben Barış. Sorularını yanıtlamak ve her konuda yardımcı olmak için buradayım."
    }
};

function selectVoiceOption(voiceKey) {
    if (!VOICE_PROFILES[voiceKey]) voiceKey = "jenna";
    currentSelectedVoice = voiceKey;
    localStorage.setItem("lumina_selected_voice", voiceKey);

    document.querySelectorAll(".voice-card").forEach(el => {
        el.classList.toggle("active", el.dataset.voice === voiceKey);
    });

    showToast("Ses Seçildi", `${VOICE_PROFILES[voiceKey].name} sesi aktif edildi.`);
}

function previewVoice(voiceKey) {
    const prof = VOICE_PROFILES[voiceKey];
    if (!prof) return;
    speakText(prof.previewText, { voiceKey, force: true });
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

function toggleSidebar() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (!sidebar) return;

    sidebar.classList.toggle("collapsed");
    if (overlay) {
        overlay.classList.toggle("active", !sidebar.classList.contains("collapsed"));
    }
}

function closeSidebarOnMobile() {
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById("sidebar");
        const overlay = document.getElementById("sidebar-overlay");
        if (sidebar) sidebar.classList.add("collapsed");
        if (overlay) overlay.classList.remove("active");
    }
}

// ============================================================
// 5. MULTI-CHAT SESSIONS (LOCALSTORAGE)
// ============================================================

function loadChatSessions() {
    try {
        const stored = localStorage.getItem("lumina_chat_sessions");
        sessions = stored ? jsonParseSafe(stored, []) : [];
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
                <p>Duygusal, zeki ve çoklu ajan destekli yapay zeka. Matematik problemlerini adım adım çözer, projelerinizi baştan sona kodlar ve foto-gerçekçi görseller üretir.</p>

                <div class="starter-grid">
                    <div class="starter-chip" onclick="quickAsk('Zor bir matematik problemini adım adım açıkla: 3x^2 - 12x + 9 = 0')">
                        <div class="starter-chip-title">📐 Matematik Çözücü</div>
                        <div class="starter-chip-desc">Denklemleri analiz, formül ve ara sağlamalarla adım adım çözdürün.</div>
                    </div>

                    <div class="starter-chip" onclick="selectAgentMode('software'); quickAsk('/proje React ve FastAPI ile tam donanımlı bir Görev Takip uygulaması mimarisi ve çalışan kodları')">
                        <div class="starter-chip-title">💻 Çoklu Ajan Yazılım</div>
                        <div class="starter-chip-desc">Mimar, Geliştirici ve QA 3'lü ajan ekibiyle baştan sona kodlayın.</div>
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
            renderUserMessageElement(msg.text, false);
        } else if (msg.role === "bot") {
            renderBotMessageElement(msg.text, msg.agentMode, false, { proactive: !!msg.proactive, smartUI: msg.smartUI, modelUsed: msg.modelUsed });
        } else if (msg.role === "image") {
            renderImageCardElement(msg.imageData, false);
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

function renderUserMessageElement(text, save = true) {
    removeStarterHero();
    const stream = document.getElementById("chat-stream");
    if (!stream) return;

    const row = document.createElement("div");
    row.className = "message-row user-row";
    row.innerHTML = `
        <div class="msg-meta">Siz</div>
        <div class="message-bubble user-bubble">${escapeHTML(text)}</div>
    `;
    stream.appendChild(row);
    scrollToBottom();

    if (save) {
        const session = getCurrentSession();
        if (session) {
            session.messages.push({ role: "user", text: text });
            if (session.messages.length === 1) {
                session.title = text.slice(0, 30) + (text.length > 30 ? "..." : "");
            }
            saveChatSessions();
        }
    }
}

function formatMarkdownAndCode(text) {
    let html = "";
    if (typeof marked !== "undefined") {
        marked.setOptions({ breaks: true, gfm: true });
        html = marked.parse(text);
    } else {
        html = escapeHTML(text).replace(/\n/g, "<br>");
    }

    // Wrap code blocks with header and copy button
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
    const preBlocks = doc.querySelectorAll("pre");

    preBlocks.forEach((pre) => {
        const code = pre.querySelector("code");
        const lang = (code && code.className) ? code.className.replace("language-", "") : "kod";

        const container = doc.createElement("div");
        container.className = "code-container";
        container.innerHTML = `
            <div class="code-header">
                <span>${lang.toUpperCase()}</span>
                <button class="copy-btn" onclick="copyCode(this)">📋 Kopyala</button>
            </div>
        `;
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

    const row = document.createElement("div");
    row.className = "message-row bot-row";

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
            const entry = { role: "bot", text: text, agentMode: agentMode };
            if (opts.proactive) entry.proactive = true;
            if (opts.modelUsed) entry.modelUsed = opts.modelUsed;
            if (smartBlocks.length) entry.smartUI = smartBlocks;
            session.messages.push(entry);
            saveChatSessions();
        }
    }
}

function renderImageCardElement(data, save = true) {
    removeStarterHero();
    const stream = document.getElementById("chat-stream");
    if (!stream) return;

    const row = document.createElement("div");
    row.className = "message-row bot-row";

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
            session.messages.push({ role: "image", imageData: data });
            saveChatSessions();
        }
    }
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

async function sendMessage() {
    const input = document.getElementById("user-input");
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    if (chatBusy()) {
        showToast("Lumina hâlâ yanıtlıyor", "Cevap gelince yeni mesajını gönderebilirsin.");
        return;
    }

    input.value = "";
    rememberFromUserText(text);   // isim gibi bilgiler bu cihazda da (ücretsiz, anında) saklanır
    noteUserActivity(true);
    startKeepAlive();          // kullanıcı hareketi içinde başlatılmalı (ses politikası)
    maybeAskNotifyPermission();

    // Check for image command
    if (text.startsWith("/görsel") || text.toLowerCase().startsWith("görsel oluştur")) {
        const prompt = text.replace(/^\/görsel|^görsel oluştur/i, "").trim();
        if (prompt) {
            renderUserMessageElement(text);
            await executeImageGeneration(prompt, selectedImageStyle, selectedImageRatio);
            return;
        }
    }

    renderUserMessageElement(text);
    const sid = currentSessionId;
    const agentMode = currentAgentMode;

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
            conversation_id: String(currentSessionId || "default").slice(0, 64)
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
        backendUrl = urlInput.value.trim() || "http://127.0.0.1:8000/api/v1";
        localStorage.setItem("lumina_backend_url", backendUrl);
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

function openAuthModal() {
    const modal = document.getElementById("auth-modal");
    if (modal) modal.style.display = "flex";
}

function closeAuthModal() {
    const modal = document.getElementById("auth-modal");
    if (modal) modal.style.display = "none";
}

function continueAsGuest() {
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
        case "auth/email-already-in-use":
            return "Bu e-posta adresi zaten kullanımda. Giriş yapmayı deneyebilirsiniz.";
        case "auth/weak-password":
            return "Şifreniz çok zayıf. Güvenliğiniz için en az 6 karakter olmalıdır.";
        case "auth/network-request-failed":
            return "Ağ bağlantısı kurulamadı. İnternet bağlantınızı kontrol edin.";
        case "auth/popup-closed-by-user":
            return "Google ile giriş penceresi kapatıldı.";
        case "auth/too-many-requests":
            return "Çok fazla başarısız deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin.";
        default:
            return err.message || "Kimlik doğrulama işlemi sırasında bir hata oluştu.";
    }
}

async function handleEmailLogin() {
    if (!isFirebaseActive) { continueAsGuest(); return; }
    const email = document.getElementById("auth-email").value.trim();
    const pass = document.getElementById("auth-password").value;
    if (!email || !pass) {
        showToast("Eksik Bilgi", "Lütfen e-posta ve şifrenizi girin.", "warning");
        return;
    }
    try {
        const cred = await auth.signInWithEmailAndPassword(email, pass);
        closeAuthModal();
        showToast("Giriş Başarılı", `Hoş geldiniz, ${cred.user.displayName || cred.user.email}!`);
        fetchSubscriptionDetails();
    } catch (e) {
        showToast("Giriş Başarısız", translateAuthError(e), "error");
    }
}

async function handleEmailRegister() {
    if (!isFirebaseActive) { continueAsGuest(); return; }
    const email = document.getElementById("auth-email").value.trim();
    const pass = document.getElementById("auth-password").value;
    if (!email || !pass) {
        showToast("Eksik Bilgi", "Lütfen e-posta ve şifrenizi girin.", "warning");
        return;
    }
    try {
        const cred = await auth.createUserWithEmailAndPassword(email, pass);
        closeAuthModal();
        showToast("Kayıt Başarılı", "Hesabınız başarıyla oluşturuldu.");
        fetchSubscriptionDetails();
    } catch (e) {
        showToast("Kayıt Başarısız", translateAuthError(e), "error");
    }
}

async function handleGoogleLogin() {
    if (!isFirebaseActive || !googleProvider) { continueAsGuest(); return; }
    try {
        const cred = await auth.signInWithPopup(googleProvider);
        closeAuthModal();
        showToast("Google Girişi", `Hoş geldiniz, ${cred.user.displayName || cred.user.email}!`);
        fetchSubscriptionDetails();
    } catch (e) {
        showToast("Google Giriş Hatası", translateAuthError(e), "error");
    }
}

async function handlePasswordReset() {
    if (!isFirebaseActive) {
        showToast("Bilgi", "Firebase aktif değil. Şifre sıfırlama çevrimdışı modda kullanılamaz.");
        return;
    }
    const email = document.getElementById("auth-email").value.trim();
    if (!email) {
        showToast("E-posta Gerekli", "Lütfen şifre sıfırlama bağlantısı göndermek için e-posta alanını doldurun.", "warning");
        return;
    }
    try {
        await auth.sendPasswordResetEmail(email);
        showToast("Sıfırlama Bağlantısı Gönderildi", `${email} adresine şifre sıfırlama e-postası iletildi.`);
    } catch (e) {
        showToast("Sıfırlama Hatası", translateAuthError(e), "error");
    }
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
    if (!voiceEnabled && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }
}

function speakText(text, opts = {}) {
    if ((!voiceEnabled && !opts.force) || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();

    const clean = text
        .replace(/```[\s\S]*?```/g, "Kod bloğu.")
        .replace(/\$\$[\s\S]*?\$\$/g, "Matematik formülü.")
        .replace(/\$[^$]*\$/g, "")
        .replace(/<[^>]*>/g, "")
        .replace(/[*_#`~]/g, "")
        .trim();

    if (!clean) {
        if (opts.onEnd) opts.onEnd();
        return;
    }

    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "tr-TR";

    const voiceKey = opts.voiceKey || currentSelectedVoice || "jenna";
    const profile = VOICE_PROFILES[voiceKey] || VOICE_PROFILES["jenna"];

    u.pitch = profile.pitch || 1.0;
    u.rate = profile.rate || 1.0;

    // Sistem seslerinden en uygununu bul (Kız sesleri Jenna vs. Erkek sesleri Tommy)
    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) {
        const preferred = profile.preferredVoices || [];
        let matchedVoice = voices.find(v => 
            v.lang.startsWith("tr") && preferred.some(p => v.name.toLowerCase().includes(p))
        );
        if (!matchedVoice) {
            matchedVoice = voices.find(v => v.lang.startsWith("tr"));
        }
        if (!matchedVoice) {
            matchedVoice = voices.find(v => preferred.some(p => v.name.toLowerCase().includes(p)));
        }
        if (matchedVoice) {
            u.voice = matchedVoice;
        }
    }

    u.onstart = () => {
        const orbWrapper = document.getElementById("voice-orb-wrapper");
        if (orbWrapper && isVoiceModeActive) {
            orbWrapper.classList.remove("listening", "thinking", "idle");
            orbWrapper.classList.add("speaking");
        }
        if (opts.onStart) opts.onStart();
    };

    const finishSpeech = () => {
        const orbWrapper = document.getElementById("voice-orb-wrapper");
        if (orbWrapper && isVoiceModeActive) {
            orbWrapper.classList.remove("speaking");
        }
        if (opts.onEnd) opts.onEnd();
    };

    u.onend = finishSpeech;
    u.onerror = finishSpeech;

    window.speechSynthesis.speak(u);
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

    // 1. Önce Backend'i dene
    let backendSuccess = false;
    try {
        const token = await getAuthToken();
        const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
        const body = JSON.stringify({
            message: text,
            agent_mode: "general",
            custom_groq_key: directGroqKey || directGitHubToken || null,
            personality: currentPersonality
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
        const entry = { role: "bot", text, agentMode };
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
        session.messages.push({ role: "image", imageData: data });
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
            smartUI: Array.isArray(data.smart_ui) ? data.smart_ui : (data.smartUI || []),
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

function triggerDocUpload() {
    const input = document.getElementById("doc-upload-input");
    if (input && !isUploadingDoc) input.click();
}

async function handleDocUpload(event) {
    const fileEl = event.target;
    const file = fileEl && fileEl.files && fileEl.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
        showToast("Dosya Çok Büyük", "Belge en fazla 5MB olabilir.", null, 7000);
        fileEl.value = "";
        return;
    }
    if (isUploadingDoc) return;
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
            filetype: data.filetype || "text"
        };
        renderAttachedDocPill(true);
        showToast("Belge Eklendi", `${data.filename} • ${formatTRNumber(data.characters)} karakter. Sorunu yazıp gönderebilirsin.`);
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
        if (name) name.textContent = `📄 ${currentAttachedDoc.filename} (${formatTRNumber(currentAttachedDoc.characters)} karakter)`;
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

function renderSmartUI(block, container) {
    if (!block || !block.type || !container) return null;
    const type = String(block.type).toLowerCase();
    const builders = {
        calculator: buildSmartCalculator,
        task_manager: buildSmartTaskManager,
        budget_planner: buildSmartBudgetPlanner,
        calendar: buildSmartCalendar,
        unit_converter: buildSmartUnitConverter,
        project_roadmap: buildSmartRoadmap,
        study_planner: buildSmartStudyPlanner,
        comparison_table: buildSmartComparisonTable,
        interactive_form: buildSmartInteractiveForm
    };
    const builder = builders[type];
    if (!builder) return null; // bilinmeyen / desteklenmeyen tip yoksayılır
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
    interactive_form: "İnteraktif Form"
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
    const mk = (label, value, color) => `
        <div class="smart-budget-stat">
            <div class="smart-budget-label">${label}</div>
            <div class="smart-budget-val" style="${color ? `color:${color};` : ""}">${formatTRNumber(value)} ${currency}</div>
        </div>`;
    summary.innerHTML =
        mk("Gelir", income, "#22c55e") +
        mk("Gider", totalExp, "#ef4444") +
        mk("Kalan", remaining, remaining >= 0 ? "#22c55e" : "#ef4444");
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
                conversation_id: String(currentSessionId || "default").slice(0, 64)
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
        deliverBotMessage(sid, cleanText, agentMode, {
            smartUI: (finalData.smart_ui && finalData.smart_ui.length ? finalData.smart_ui : parsedClient.blocks).map(b => sanitizeClientSmartBlock(b)),
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
                    smartUI: p.blocks.map(b => sanitizeClientSmartBlock(b))
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

function sanitizeClientSmartBlock(block) {
    // Smart UI bloğu zaten backend'de doğrulanmış; frontend bir daha derinlemesine
    // işleyemez. Yalnızca beklenen alanlar korunur ve dize uzunlukları sınırlanır.
    if (!block || typeof block !== "object") return { type: "interactive_form", data: {} };
    return {
        type: String(block.type).slice(0, 40),
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
