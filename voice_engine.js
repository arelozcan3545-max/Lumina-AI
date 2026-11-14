// ============================================================
// LUMINA AI - VOICE ENGINE (voice_engine.js)
// ============================================================
// Amac: secilen ses profilini GERCEK bir saglayici ses kimligine
// baglamak. Ayni saglayici ses kimligi iki farkli profile atanmaz.
// Pitch ile "farkli konusmaci" taklidi YAPILMAZ (pitch daima 1.0).
//
// Saglayicilar:
//   - browser : SpeechSynthesis (cevrimdisi, cihaz envanterine bagli)
//   - google  : Google Cloud TTS (sunucu anahtari gerekir)
//   - azure   : Microsoft Azure Speech (sunucu anahtari gerekir)
//
// Onemli: bulut saglayicilar yalnizca backend /voice/catalog
// "configured: true" dediginde kullanilabilir sayilir.
// ============================================================

(function (root) {
    "use strict";

    // ------------------------------------------------------------
    // Kayit defteri (voice_registry.py ile ayni gercek ses kimlikleri)
    // ------------------------------------------------------------
    const DEFAULT_PROFILES = [
        {
            id: "jenna", name: "Jenna", gender: "female", persona: "Canlı, Tatlı & Neşeli",
            rate: 1.05,
            previewText: "Merhaba! Ben Jenna. Cıvıl cıvıl ve enerjik bir kadın sesiyim. Seninle sohbet etmek harika!",
            google: { voice_id: "tr-TR-Wavenet-A", label: "Aylin (WaveNet)" },
            azure: { voice_id: "tr-TR-EmelNeural", label: "Emel (Neural)" },
            browserNames: ["emel", "aylin", "filiz", "yelda", "google türkçe", "google turkce"]
        },
        {
            id: "emma", name: "Emma", gender: "female", persona: "Sakin, Sıcak & Huzurlu",
            rate: 0.92,
            previewText: "Selam. Ben Emma. Sakin, dinlendirici ve huzurlu bir kadın sesiyim. Aklındakileri rahatça paylaşabilirsin.",
            google: { voice_id: "tr-TR-Wavenet-C", label: "Berna (WaveNet)" },
            browserNames: ["filiz", "berna", "yelda", "emel"]
        },
        {
            id: "elif", name: "Elif", gender: "female", persona: "Akıcı & Doğal Türkçe",
            rate: 1.0,
            previewText: "Merhaba, ben Elif! Çok net, berrak ve akıcı bir Türkçe diksiyonuyla size yardımcı olmaktan mutluluk duyarım.",
            google: { voice_id: "tr-TR-Wavenet-D", label: "Başak (WaveNet)" },
            browserNames: ["başak", "basak", "dilara", "zeynep"]
        },
        {
            id: "tommy", name: "Tommy", gender: "male", persona: "Dinamik, Genç & Hızlı",
            rate: 1.08,
            previewText: "Selam dostum! Ben Tommy. Hızlı, dinamik ve enerjik bir erkek sesiyim. Hadi hemen başlayalım!",
            google: { voice_id: "tr-TR-Wavenet-B", label: "Berat (WaveNet)" },
            azure: { voice_id: "tr-TR-AhmetNeural", label: "Ahmet (Neural)" },
            browserNames: ["tolga", "berat", "ahmet", "cem", "can"]
        },
        {
            id: "david", name: "David", gender: "male", persona: "Tok, Karizmatik & Derin",
            rate: 0.94,
            previewText: "İyi günler. Ben David. Tok, derin ve net bir erkek sesiyle analitik çözümlerde yanınızdayım.",
            google: { voice_id: "tr-TR-Wavenet-E", label: "Ömer (WaveNet)" },
            browserNames: ["ömer", "omer", "cem", "barış", "baris"]
        },
        {
            id: "baris", name: "Barış", gender: "male", persona: "Samimi & Doğal Erkek",
            rate: 1.0,
            previewText: "Selam! Ben Barış. Tıpkı karşılıklı konuşan yakın bir arkadaşın gibi doğal ve samimi bir erkek sesiyim.",
            google: { voice_id: "tr-TR-Standard-B", label: "Ahmet (Standard)" },
            browserNames: ["ahmet", "tolga", "can", "erkek"]
        }
    ];

    const PROVIDERS = {
        browser: { id: "browser", name: "Tarayıcı SpeechSynthesis", platforms: ["desktop", "mobile"], free: true },
        google: { id: "google", name: "Google Cloud TTS", platforms: ["desktop", "mobile"], free: false },
        azure: { id: "azure", name: "Microsoft Azure Speech", platforms: ["desktop", "mobile"], free: false }
    };

    const PREF_KEY = "lumina_voice_pref_v2";
    const LEGACY_VOICE_KEY = "lumina_selected_voice";
    const CACHE_LIMIT = 40;
    const VOICES_TIMEOUT_MS = 3000;

    // ------------------------------------------------------------
    // Durum
    // ------------------------------------------------------------
    const state = {
        configured: false,
        backendUrl: null,
        getToken: null,
        getBackendUrl: null,
        catalog: null,
        cloudConfigured: { google: false, azure: false },
        browserAssignments: {},   // profileId -> {voice, voiceURI, name, lang, gender}
        voicesLoaded: false,
        preference: loadLocalPreference(),
        cache: new Map(),
        playToken: 0,
        currentAudio: null,
        currentUtterance: null,
        lastDiagnostics: null,
        availableProfiles: {},
        warnings: []
    };

    function safeLocalStorageGet(key) {
        try { return root.localStorage ? root.localStorage.getItem(key) : null; } catch (e) { return null; }
    }
    function safeLocalStorageSet(key, value) {
        try { if (root.localStorage) root.localStorage.setItem(key, value); } catch (e) { /* yoksay */ }
    }

    function loadLocalPreference() {
        try {
            const raw = safeLocalStorageGet(PREF_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.profileId) return parsed;
            }
        } catch (e) { /* bozuk kayit */ }
        const legacy = safeLocalStorageGet(LEGACY_VOICE_KEY);
        if (legacy && DEFAULT_PROFILES.some(p => p.id === legacy)) {
            return { profileId: legacy, provider: null, updatedAt: 0 };
        }
        return { profileId: "jenna", provider: null, updatedAt: 0 };
    }

    function saveLocalPreference(pref) {
        state.preference = pref;
        safeLocalStorageSet(PREF_KEY, JSON.stringify(pref));
        safeLocalStorageSet(LEGACY_VOICE_KEY, pref.profileId);
    }

    // ------------------------------------------------------------
    // Saf yardimcilar (Node testlerinde dogrudan kullanilir)
    // ------------------------------------------------------------

    function isTurkishVoice(voice) {
        if (!voice) return false;
        const lang = String(voice.lang || "").toLowerCase().replace("_", "-");
        return lang === "tr" || lang.startsWith("tr-");
    }

    function guessVoiceGender(name) {
        const n = String(name || "").toLowerCase();
        const female = ["emel", "filiz", "yelda", "dilara", "zeynep", "seda", "aylin", "berna", "başak", "basak", "female", "kadın", "kadin", "kız", "kiz", "woman", "girl"];
        const male = ["tolga", "ahmet", "cem", "can", "barış", "baris", "berat", "ömer", "omer", "male", "erkek", "adam", "man", "boy"];
        if (female.some(k => n.includes(k))) return "female";
        if (male.some(k => n.includes(k))) return "male";
        return "unknown";
    }

    function voiceIdentity(voice) {
        if (!voice) return "";
        return String(voice.voiceURI || voice.name || "") + "|" + String(voice.lang || "");
    }

    /**
     * Her profile BENZERSIZ bir tarayici sesi atar.
     * Ayni ses iki profile atanmaz. Cinsiyet uyusmuyorsa profil
     * "kullanilamaz" kalir; pitch ile taklit yapilmaz.
     */
    function assignUniqueBrowserVoices(profiles, voices) {
        const list = Array.isArray(voices) ? voices.filter(isTurkishVoice) : [];
        // Ayni fiziksel sesi (voiceURI) tekillestir.
        const unique = [];
        const seen = new Set();
        for (const v of list) {
            const key = voiceIdentity(v);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            unique.push({
                voice: v,
                name: v.name || "",
                voiceURI: v.voiceURI || v.name || "",
                lang: v.lang || "tr-TR",
                gender: guessVoiceGender(v.name)
            });
        }

        // Kararli siralama: ayni cihazda her zaman ayni atama.
        unique.sort((a, b) => a.name.localeCompare(b.name, "tr"));

        const assignments = {};
        const used = new Set();
        const orderedProfiles = profiles.slice();

        // 1. Tercih edilen isim eslesmeleri (yalnizca cinsiyet uyumlu).
        for (const profile of orderedProfiles) {
            const names = (profile.browserNames || []).map(s => s.toLowerCase());
            const match = unique.find(c =>
                !used.has(voiceIdentity(c.voice)) &&
                (c.gender === profile.gender || c.gender === "unknown") &&
                names.some(n => c.name.toLowerCase().includes(n))
            );
            if (match) {
                assignments[profile.id] = match;
                used.add(voiceIdentity(match.voice));
            }
        }

        // 2. Ayni cinsiyette kalan benzersiz sesler.
        for (const profile of orderedProfiles) {
            if (assignments[profile.id]) continue;
            const match = unique.find(c =>
                !used.has(voiceIdentity(c.voice)) &&
                c.gender === profile.gender
            );
            if (match) {
                assignments[profile.id] = match;
                used.add(voiceIdentity(match.voice));
            }
        }

        // 3. Cinsiyeti bilinmeyen sesler (son care, yine benzersiz).
        for (const profile of orderedProfiles) {
            if (assignments[profile.id]) continue;
            const match = unique.find(c =>
                !used.has(voiceIdentity(c.voice)) &&
                c.gender === "unknown"
            );
            if (match) {
                assignments[profile.id] = match;
                used.add(voiceIdentity(match.voice));
            }
        }

        return assignments;
    }

    function voiceCacheKey(parts) {
        const p = parts || {};
        return [
            String(p.text || ""),
            String(p.provider || ""),
            String(p.voiceId || ""),
            String(p.lang || "tr-TR"),
            String(p.rate == null ? 1 : p.rate),
            String(p.profileId || "")
        ].join("|");
    }

    function pickFallbackProfile(preferenceId, availability) {
        const avail = availability || {};
        if (avail[preferenceId]) return preferenceId;
        for (const key of Object.keys(avail)) {
            if (avail[key]) return key;
        }
        return null;
    }

    function detectPlatform() {
        try {
            if (root.matchMedia && root.matchMedia("(max-width: 900px)").matches) return "mobile";
        } catch (e) { /* yoksay */ }
        return "desktop";
    }

    function cleanForSpeech(text) {
        return String(text || "")
            .replace(/```[\s\S]*?```/g, " Kod bloğu. ")
            .replace(/`([^`]+)`/g, "$1")
            .replace(/\$\$[\s\S]*?\$\$/g, " Matematik formülü. ")
            .replace(/\$[^$]*\$/g, "")
            .replace(/<[^>]*>/g, "")
            .replace(/https?:\/\/\S+/gi, " web bağlantısı ")
            .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, "")
            .replace(/[*_#~>\[\]\(\)\{\}\\|]/g, " ")
            .replace(/\s{2,}/g, " ")
            .trim();
    }

    // ------------------------------------------------------------
    // Tarayici seslerini bekle
    // ------------------------------------------------------------
    function waitForVoices(timeoutMs) {
        return new Promise((resolve) => {
            const synth = root.speechSynthesis;
            if (!synth || typeof synth.getVoices !== "function") {
                resolve([]);
                return;
            }
            const initial = synth.getVoices() || [];
            if (initial.length) {
                resolve(initial);
                return;
            }

            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                try { clearTimeout(timer); } catch (e) { /* yoksay */ }
                try {
                    if (synth.removeEventListener) synth.removeEventListener("voiceschanged", onChange);
                } catch (e) { /* yoksay */ }
                resolve(synth.getVoices() || []);
            };
            const onChange = () => {
                const voices = synth.getVoices() || [];
                if (voices.length) finish();
            };
            const timer = setTimeout(finish, timeoutMs || VOICES_TIMEOUT_MS);

            try {
                if (synth.addEventListener) synth.addEventListener("voiceschanged", onChange);
                // Eski Safari/Chrome icin ek yol.
                const previous = synth.onvoiceschanged;
                synth.onvoiceschanged = function (event) {
                    try { if (typeof previous === "function") previous.call(synth, event); } catch (e) { /* yoksay */ }
                    onChange();
                };
            } catch (e) { /* yoksay */ }
        });
    }

    // ------------------------------------------------------------
    // Katalog
    // ------------------------------------------------------------
    async function fetchServerCatalog() {
        const url = getBackendUrl();
        if (!url) return null;
        try {
            const response = await fetch(`${url}/voice/catalog`, {
                method: "GET",
                headers: { "Accept": "application/json" },
                cache: "no-store"
            });
            if (!response.ok) return null;
            return await response.json();
        } catch (e) {
            return null;
        }
    }

    function getBackendUrl() {
        if (typeof state.getBackendUrl === "function") {
            try { return state.getBackendUrl(); } catch (e) { return null; }
        }
        return state.backendUrl || null;
    }

    async function getAuthTokenSafe() {
        if (typeof state.getToken === "function") {
            try { return await state.getToken(); } catch (e) { return null; }
        }
        return null;
    }

    function applyCatalog(catalog) {
        state.catalog = catalog;
        const providers = (catalog && catalog.providers) || [];
        const cloud = { google: false, azure: false };
        for (const provider of providers) {
            if (provider && provider.id && cloud[provider.id] !== undefined) {
                cloud[provider.id] = Boolean(provider.configured);
            }
        }
        // tts_providers alanı daha ayrıntılıysa onu kullan.
        const tts = (catalog && catalog.tts_providers) || null;
        if (tts) {
            if (tts.google) cloud.google = Boolean(tts.google.configured);
            if (tts.azure) cloud.azure = Boolean(tts.azure.configured);
        }
        state.cloudConfigured = cloud;
    }

    // ------------------------------------------------------------
    // Kullanilabilirlik
    // ------------------------------------------------------------
    function computeAvailability(profiles) {
        const availability = {};
        const details = {};
        for (const profile of profiles) {
            const providers = [];
            if (state.cloudConfigured.google && profile.google && profile.google.voice_id) {
                providers.push({ provider: "google", voice_id: profile.google.voice_id, label: profile.google.label || profile.google.voice_id, available: true });
            }
            if (state.cloudConfigured.azure && profile.azure && profile.azure.voice_id) {
                providers.push({ provider: "azure", voice_id: profile.azure.voice_id, label: profile.azure.label || profile.azure.voice_id, available: true });
            }
            const browser = state.browserAssignments[profile.id];
            if (browser) {
                providers.push({ provider: "browser", voice_id: browser.voiceURI, label: browser.name, available: true });
            } else {
                providers.push({ provider: "browser", voice_id: null, label: "Bu cihazda ayrı ses yok", available: false });
            }
            const available = providers.some(p => p.available);
            availability[profile.id] = available;
            details[profile.id] = { available, providers };
        }
        state.availableProfiles = details;
        return availability;
    }

    function resolveProfile(profileId) {
        return DEFAULT_PROFILES.find(p => p.id === profileId) || null;
    }

    // ------------------------------------------------------------
    // Yapilandirma / baslatma
    // ------------------------------------------------------------
    async function init(options) {
        const opts = options || {};
        if (opts.backendUrl !== undefined) state.backendUrl = opts.backendUrl;
        if (opts.getBackendUrl) state.getBackendUrl = opts.getBackendUrl;
        if (opts.getToken) state.getToken = opts.getToken;
        state.configured = true;

        const catalog = await fetchServerCatalog();
        if (catalog) applyCatalog(catalog);

        const voices = await waitForVoices(opts.voicesTimeoutMs);
        state.voicesLoaded = voices.length > 0;
        state.browserAssignments = assignUniqueBrowserVoices(DEFAULT_PROFILES, voices);

        const availability = computeAvailability(DEFAULT_PROFILES);
        state.warnings = [];
        if (!state.cloudConfigured.google && !state.cloudConfigured.azure) {
            state.warnings.push("Bulut TTS yapılandırılmamış; tarayıcı sesleri kullanılacak.");
        }
        if (voices.length && Object.keys(state.browserAssignments).length === 0) {
            state.warnings.push("Bu cihazda Türkçe ses bulunamadı; profil sesleri kullanılamıyor.");
        }

        // Tercihi sunucudan oku (hesap varsa cihazlar arası).
        await syncPreferenceFromServer();

        return {
            configured: true,
            voicesLoaded: state.voicesLoaded,
            browserVoiceCount: voices.length,
            assignedProfiles: Object.keys(state.browserAssignments),
            cloudConfigured: state.cloudConfigured,
            availability,
            preference: state.preference,
            warnings: state.warnings.slice()
        };
    }

    async function syncPreferenceFromServer() {
        const url = getBackendUrl();
        if (!url) return;
        const token = await getAuthTokenSafe();
        if (!token) return;
        try {
            const response = await fetch(`${url}/voice/preference`, {
                headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
                cache: "no-store"
            });
            if (!response.ok) return;
            const data = await response.json();
            const remote = (data && data.preference) || {};
            if (!remote.profile_id) return;
            const remoteUpdated = Number(remote.updated_at || 0);
            const localUpdated = Number(state.preference.updatedAt || 0);
            if (remoteUpdated >= localUpdated) {
                saveLocalPreference({
                    profileId: String(remote.profile_id),
                    provider: remote.provider || null,
                    updatedAt: remoteUpdated
                });
            } else {
                await pushPreferenceToServer(state.preference);
            }
        } catch (e) { /* ag hatasi: yerel tercih korunur */ }
    }

    async function pushPreferenceToServer(pref) {
        const url = getBackendUrl();
        if (!url) return false;
        const token = await getAuthTokenSafe();
        if (!token) return false;
        try {
            const response = await fetch(`${url}/voice/preference`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    profile_id: pref.profileId,
                    provider: pref.provider || null
                })
            });
            return response.ok;
        } catch (e) {
            return false;
        }
    }

    async function setPreference(profileId, provider) {
        if (!resolveProfile(profileId)) {
            throw new Error("Geçersiz ses profili.");
        }
        const pref = {
            profileId,
            provider: provider || null,
            updatedAt: Math.floor(Date.now() / 1000)
        };
        saveLocalPreference(pref);
        await pushPreferenceToServer(pref);
        return pref;
    }

    // ------------------------------------------------------------
    // Oynatma
    // ------------------------------------------------------------
    function stop() {
        state.playToken += 1;
        try {
            if (root.speechSynthesis) root.speechSynthesis.cancel();
        } catch (e) { /* yoksay */ }
        if (state.currentAudio) {
            try {
                state.currentAudio.pause();
                state.currentAudio.src = "";
            } catch (e) { /* yoksay */ }
            state.currentAudio = null;
        }
        state.currentUtterance = null;
    }

    function cacheGet(key) {
        return state.cache.get(key) || null;
    }

    function cacheSet(key, value) {
        // The engine is hosted in a browser tab; keep memory bounded.
        if (state.cache.size >= CACHE_LIMIT) {
            const oldest = state.cache.keys().next().value;
            const old = state.cache.get(oldest);
            if (old && old.objectUrl) {
                try { URL.revokeObjectURL(old.objectUrl); } catch (e) { /* yoksay */ }
            }
            state.cache.delete(oldest);
        }
        state.cache.set(key, value);
    }

    function clearCache() {
        for (const value of state.cache.values()) {
            if (value && value.objectUrl) {
                try { URL.revokeObjectURL(value.objectUrl); } catch (e) { /* yoksay */ }
            }
        }
        state.cache.clear();
    }

    function base64ToBlobUrl(base64, mimeType) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mimeType || "audio/mpeg" });
        return URL.createObjectURL(blob);
    }

    function playAudioUrl(objectUrl, token, callbacks) {
        return new Promise((resolve, reject) => {
            if (state.playToken !== token) {
                resolve({ cancelled: true });
                return;
            }
            const audio = new root.Audio(objectUrl);
            state.currentAudio = audio;
            let settled = false;
            const finish = (cancelled) => {
                if (settled) return;
                settled = true;
                resolve({ cancelled: Boolean(cancelled) });
            };
            audio.onplay = () => { if (callbacks && callbacks.onStart) callbacks.onStart(); };
            audio.onended = () => {
                if (state.currentAudio === audio) state.currentAudio = null;
                finish(false);
            };
            audio.onerror = () => {
                if (state.currentAudio === audio) state.currentAudio = null;
                reject(new Error("Ses dosyası oynatılamadı."));
            };
            audio.onpause = () => {
                if (state.currentAudio === audio) state.currentAudio = null;
                finish(true);
            };
            const promise = audio.play();
            if (promise && typeof promise.catch === "function") {
                promise.catch((err) => {
                    if (state.playToken !== token) finish(true);
                    else reject(new Error("Tarayıcı ses oynatmayı engelledi: " + (err && err.message ? err.message : "bilinmeyen hata")));
                });
            }
        });
    }

    function speakBrowser(cleanText, profileId, token, callbacks) {
        return new Promise((resolve, reject) => {
            const synth = root.speechSynthesis;
            if (!synth || typeof root.SpeechSynthesisUtterance !== "function") {
                reject(new Error("Bu tarayıcı SpeechSynthesis desteklemiyor."));
                return;
            }
            const assigned = state.browserAssignments[profileId];
            if (!assigned || !assigned.voice) {
                reject(new Error("Bu cihazda seçilen profil için ayrı bir Türkçe ses yok."));
                return;
            }
            if (state.playToken !== token) {
                resolve({ cancelled: true });
                return;
            }
            const profile = resolveProfile(profileId);
            const utterance = new root.SpeechSynthesisUtterance(cleanText);
            utterance.voice = assigned.voice;
            utterance.lang = assigned.lang || "tr-TR";
            // Pitch DEGISTIRILMEZ. Farkli konusmaci = farkli voice kimligi.
            utterance.pitch = 1.0;
            utterance.rate = profile && profile.rate ? profile.rate : 1.0;
            state.currentUtterance = utterance;
            let settled = false;
            const finish = (cancelled) => {
                if (settled) return;
                settled = true;
                if (state.currentUtterance === utterance) state.currentUtterance = null;
                resolve({ cancelled: Boolean(cancelled) });
            };
            utterance.onstart = () => { if (callbacks && callbacks.onStart) callbacks.onStart(); };
            utterance.onend = () => finish(false);
            utterance.onerror = (event) => {
                const code = event && event.error ? event.error : "unknown";
                if (code === "interrupted" || code === "canceled") {
                    finish(true);
                } else {
                    reject(new Error("Tarayıcı sesi üretilemedi: " + code));
                }
            };
            try { synth.speak(utterance); }
            catch (e) { reject(new Error("Tarayıcı sesi başlatılamadı.")); }
        });
    }

    async function synthesizeCloud(cleanText, profile, provider, token) {
        const url = getBackendUrl();
        if (!url) throw new Error("Bulut sesi için backend yapılandırılmamış.");
        const authToken = await getAuthTokenSafe();
        const response = await fetch(`${url}/voice/tts`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(authToken ? { "Authorization": `Bearer ${authToken}` } : {})
            },
            body: JSON.stringify({
                text: cleanText,
                profile_id: profile.id,
                provider: provider || null
            })
        });
        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try { const data = await response.json(); if (data && data.detail) detail = data.detail; } catch (e) { /* yoksay */ }
            throw new Error(detail);
        }
        return await response.json();
    }

    function buildDiagnostics(input) {
        return {
            requested_profile: input.requestedProfile,
            actual_profile: input.actualProfile,
            requested_provider: input.requestedProvider,
            actual_provider: input.actualProvider,
            requested_voice_id: input.requestedVoiceId || null,
            actual_voice_id: input.actualVoiceId || null,
            platform: detectPlatform(),
            fallback: Boolean(input.fallback),
            fallback_reason: input.fallbackReason || null,
            status: input.status || "generated",
            cached: Boolean(input.cached),
            timestamp: Date.now()
        };
    }

    /**
     * Ana giris noktasi. Onizleme ve normal yanitlar AYNI yolu kullanir.
     */
    async function speak(text, options) {
        const opts = options || {};
        if (!state.configured) {
            await init({});
        }
        if (opts.force !== true && opts.enabled === false) {
            return { success: false, reason: "disabled", diagnostics: null };
        }

        const clean = opts.cleanText != null ? String(opts.cleanText) : cleanForSpeech(text);
        if (!clean) {
            if (opts.onEnd) opts.onEnd();
            return { success: false, reason: "empty", diagnostics: null };
        }

        stop();
        const token = state.playToken;

        const requestedProfileId = opts.profileId || state.preference.profileId || "jenna";
        const requestedProfile = resolveProfile(requestedProfileId) || resolveProfile("jenna");
        let actualProfile = requestedProfile;
        let fallback = false;
        let fallbackReason = null;

        const availability = computeAvailability(DEFAULT_PROFILES);
        if (!availability[requestedProfile.id]) {
            const alternative = pickFallbackProfile(requestedProfile.id, availability);
            if (!alternative) {
                const error = new Error(
                    "Seçilen ses bu cihazda ve yapılandırılmış sağlayıcılarda kullanılamıyor. " +
                    "Lütfen farklı bir ses seçin veya yöneticiden TTS sağlayıcısı yapılandırmasını isteyin."
                );
                if (opts.onError) opts.onError(error);
                return { success: false, reason: "unavailable", error: error.message, diagnostics: null };
            }
            actualProfile = resolveProfile(alternative);
            fallback = true;
            fallbackReason = `'${requestedProfile.name}' bu ortamda kullanılamıyor; '${actualProfile.name}' ile oynatıldı.`;
            if (opts.onFallback) opts.onFallback(fallbackReason, requestedProfile.id, actualProfile.id);
        }

        const requestedProvider = (opts.provider || state.preference.provider || "").toLowerCase() || null;
        let providerOrder = [];
        if (requestedProvider === "browser") {
            providerOrder = ["browser"];
        } else if (requestedProvider === "google" || requestedProvider === "azure") {
            providerOrder = [requestedProvider];
            if (opts.allowProviderFallback !== false) {
                if (state.cloudConfigured.google && requestedProvider !== "google") providerOrder.push("google");
                if (state.cloudConfigured.azure && requestedProvider !== "azure") providerOrder.push("azure");
                providerOrder.push("browser");
            }
        } else {
            if (state.cloudConfigured.google) providerOrder.push("google");
            if (state.cloudConfigured.azure) providerOrder.push("azure");
            providerOrder.push("browser");
        }

        const errors = [];
        for (const provider of providerOrder) {
            if (state.playToken !== token) {
                return { success: false, reason: "cancelled", diagnostics: null };
            }
            try {
                if (provider === "google" || provider === "azure") {
                    const voiceEntry = actualProfile[provider];
                    if (!voiceEntry || !voiceEntry.voice_id) {
                        errors.push(`${provider}: ses kimliği yok`);
                        continue;
                    }
                    const cacheKey = voiceCacheKey({
                        text: clean,
                        provider,
                        voiceId: voiceEntry.voice_id,
                        lang: "tr-TR",
                        rate: actualProfile.rate,
                        profileId: actualProfile.id
                    });
                    let cached = cacheGet(cacheKey);
                    let diagnostics;
                    let objectUrl;
                    if (cached && cached.objectUrl) {
                        objectUrl = cached.objectUrl;
                        diagnostics = buildDiagnostics({
                            requestedProfile: requestedProfile.id,
                            actualProfile: actualProfile.id,
                            requestedProvider,
                            actualProvider: provider,
                            requestedVoiceId: requestedProvider ? (requestedProfile[requestedProvider] || {}).voice_id : null,
                            actualVoiceId: voiceEntry.voice_id,
                            fallback: fallback || (requestedProvider && provider !== requestedProvider),
                            fallbackReason: fallbackReason || (requestedProvider && provider !== requestedProvider ? `${requestedProvider} kullanılamadı; ${provider} kullanıldı.` : null),
                            status: "generated",
                            cached: true
                        });
                    } else {
                        const result = await synthesizeCloud(clean, actualProfile, provider, token);
                        if (!result || !result.audio_base64) {
                            errors.push(`${provider}: ses verisi boş`);
                            continue;
                        }
                        objectUrl = base64ToBlobUrl(result.audio_base64, result.mime_type);
                        cacheSet(cacheKey, { objectUrl, diagnostics: result });
                        diagnostics = buildDiagnostics({
                            requestedProfile: requestedProfile.id,
                            actualProfile: actualProfile.id,
                            requestedProvider,
                            actualProvider: result.actual_provider || provider,
                            requestedVoiceId: result.requested_voice_id,
                            actualVoiceId: result.actual_voice_id,
                            fallback: Boolean(fallback || result.fallback || (requestedProvider && provider !== requestedProvider)),
                            fallbackReason: fallbackReason || result.fallback_reason || (requestedProvider && provider !== requestedProvider ? `${requestedProvider} kullanılamadı; ${provider} kullanıldı.` : null),
                            status: "generated",
                            cached: false
                        });
                    }
                    state.lastDiagnostics = diagnostics;
                    if (opts.onState) opts.onState("loading", diagnostics);
                    const playback = await playAudioUrl(objectUrl, token, opts);
                    if (opts.onEnd) opts.onEnd();
                    return { success: true, cancelled: playback.cancelled, profileId: actualProfile.id, provider, diagnostics };
                }

                // Tarayici yolu
                const assigned = state.browserAssignments[actualProfile.id];
                if (!assigned) {
                    errors.push("browser: bu profil için benzersiz Türkçe ses yok");
                    continue;
                }
                const diagnostics = buildDiagnostics({
                    requestedProfile: requestedProfile.id,
                    actualProfile: actualProfile.id,
                    requestedProvider,
                    actualProvider: "browser",
                    requestedVoiceId: assigned.voiceURI,
                    actualVoiceId: assigned.voiceURI,
                    fallback: fallback || Boolean(requestedProvider && requestedProvider !== "browser"),
                    fallbackReason: fallbackReason || (requestedProvider && requestedProvider !== "browser" ? `${requestedProvider} kullanılamadı; tarayıcı sesi kullanıldı.` : null),
                    status: "generated",
                    cached: false
                });
                state.lastDiagnostics = diagnostics;
                if (opts.onState) opts.onState("loading", diagnostics);
                const playback = await speakBrowser(clean, actualProfile.id, token, opts);
                if (opts.onEnd) opts.onEnd();
                return { success: true, cancelled: playback.cancelled, profileId: actualProfile.id, provider: "browser", diagnostics };
            } catch (error) {
                errors.push(`${provider}: ${error && error.message ? error.message : error}`);
                if (provider === providerOrder[providerOrder.length - 1] && opts.onError) {
                    opts.onError(error);
                }
            }
        }

        const error = new Error(
            "Ses üretilemedi. " + (errors.length ? errors.join("; ") : "Kullanılabilir sağlayıcı yok.")
        );
        if (opts.onError) opts.onError(error);
        state.lastDiagnostics = buildDiagnostics({
            requestedProfile: requestedProfile.id,
            actualProfile: actualProfile.id,
            requestedProvider,
            actualProvider: null,
            fallback,
            fallbackReason,
            status: "error"
        });
        return { success: false, reason: "error", error: error.message, diagnostics: state.lastDiagnostics };
    }

    async function preview(profileId, options) {
        const opts = options || {};
        const profile = resolveProfile(profileId);
        if (!profile) throw new Error("Geçersiz ses profili.");
        return speak(profile.previewText, {
            ...opts,
            profileId: profile.id,
            force: true
        });
    }

    function getProfiles() {
        const availability = computeAvailability(DEFAULT_PROFILES);
        return DEFAULT_PROFILES.map(profile => {
            const detail = state.availableProfiles[profile.id] || { available: false, providers: [] };
            return {
                id: profile.id,
                name: profile.name,
                gender: profile.gender,
                persona: profile.persona,
                rate: profile.rate,
                previewText: profile.previewText,
                available: Boolean(availability[profile.id]),
                providers: detail.providers,
                browserVoice: state.browserAssignments[profile.id]
                    ? state.browserAssignments[profile.id].name
                    : null
            };
        });
    }

    function getDiagnostics() {
        return {
            last: state.lastDiagnostics,
            cloudConfigured: { ...state.cloudConfigured },
            voicesLoaded: state.voicesLoaded,
            assignedProfiles: Object.keys(state.browserAssignments),
            preference: { ...state.preference },
            warnings: state.warnings.slice()
        };
    }

    function configure(options) {
        const opts = options || {};
        if (opts.backendUrl !== undefined) state.backendUrl = opts.backendUrl;
        if (opts.getBackendUrl) state.getBackendUrl = opts.getBackendUrl;
        if (opts.getToken) state.getToken = opts.getToken;
        state.configured = true;
        return true;
    }

    const api = {
        init,
        configure,
        speak,
        preview,
        stop,
        clearCache,
        setPreference,
        getProfiles,
        getDiagnostics,
        getPreference: () => ({ ...state.preference }),
        // Saf yardimcilar (testler ve teshis icin)
        assignUniqueBrowserVoices,
        guessVoiceGender,
        isTurkishVoice,
        voiceCacheKey,
        pickFallbackProfile,
        cleanForSpeech,
        DEFAULT_PROFILES,
        PROVIDERS
    };

    if (root) {
        root.LuminaVoice = api;
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
