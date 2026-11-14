// ============================================================
// LUMINA AI - LOCATION UI (İZİN, ŞEHİR, HARİTA, CANLI KARTLAR)
// ------------------------------------------------------------
// Bu dosya yalnızca DOM ve tarayıcı API'leriyle çalışır. API
// anahtarı içermez. Cihaz koordinatı yalnızca açık izinle ve
// yalnızca bu oturum için bellekte tutulur.
// ============================================================

(function (global) {
    "use strict";

    const state = {
        configured: false,
        config: null,
        preference: null,
        sessionFix: null,          // { latitude, longitude, label, at } - asla diske yazılmaz
        browserPermission: "unknown",
        lastError: null,
        pendingRetryPrompt: null,
        mapLoaders: {},
        initialized: false
    };

    const CITY_SUGGESTIONS = ["İstanbul", "Ankara", "İzmir", "Bursa", "Antalya", "Adana"];

    // ------------------------------------------------------------
    // Küçük yardımcılar (saf; Node testlerinde de kullanılır)
    // ------------------------------------------------------------

    function roundCoordinate(value, decimals) {
        const num = Number(value);
        if (!isFinite(num)) return null;
        const factor = Math.pow(10, decimals);
        return Math.round(num * factor) / factor;
    }

    function safeUrl(raw) {
        if (typeof raw !== "string" || !raw.trim()) return null;
        try {
            const url = new URL(raw.trim());
            if (url.protocol !== "https:" && url.protocol !== "http:") return null;
            if (!/^https?:\/\//i.test(raw.trim())) return null;
            return url.href;
        } catch (e) {
            return null;
        }
    }

    function formatDistance(km) {
        const value = Number(km);
        if (!isFinite(value) || value < 0) return "Mesafe bilinmiyor";
        if (value < 1) return `${Math.round(value * 1000)} m`;
        return `${value.toFixed(value < 10 ? 2 : 1)} km`;
    }

    function formatRating(rating, reviews) {
        const hasRating = rating !== null && rating !== undefined && rating !== ""
            && isFinite(Number(rating));
        const ratingText = hasRating ? `${Number(rating).toFixed(1)} / 5` : "Puan yok";
        const hasReviews = reviews !== null && reviews !== undefined && reviews !== "";
        const reviewText = hasReviews ? `${reviews} yorum` : "Yorum sayısı yok";
        return `${ratingText} · ${reviewText}`;
    }

    function formatFetchedAt(iso) {
        if (!iso) return "Alınma zamanı bilinmiyor";
        const date = new Date(iso);
        if (isNaN(date.getTime())) return String(iso).slice(0, 32);
        try {
            return `Alındı: ${date.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })}`;
        } catch (e) {
            return `Alındı: ${date.toLocaleString("tr-TR")}`;
        }
    }

    function isPermissionBlocked(pref) {
        const permission = pref && pref.permission;
        return permission === "denied" || permission === "off";
    }

    function canAskPermission(pref) {
        if (isPermissionBlocked(pref)) return false;
        if (state.browserPermission === "denied") return false;
        return true;
    }

    function pickRankingList(blockData, ranking) {
        if (!blockData || typeof blockData !== "object") return [];
        if (ranking === "nearest" && Array.isArray(blockData.nearest) && blockData.nearest.length) {
            return blockData.nearest;
        }
        if (ranking === "top_rated" && Array.isArray(blockData.top_rated) && blockData.top_rated.length) {
            return blockData.top_rated;
        }
        return Array.isArray(blockData.places) ? blockData.places : [];
    }

    function buildPlaceRowModel(place) {
        if (!place || typeof place !== "object") return null;
        const name = String(place.name || "").trim();
        if (!name) return null;
        const lat = Number(place.latitude);
        const lng = Number(place.longitude);
        return {
            name,
            address: place.address ? String(place.address) : "Adres bilgisi yok",
            ratingText: formatRating(place.rating, place.review_count),
            distanceText: formatDistance(place.distance_km),
            badge: place.badge ? String(place.badge).slice(0, 40) : null,
            priceLevel: place.price_level ? String(place.price_level).slice(0, 40) : null,
            phone: place.phone ? String(place.phone).slice(0, 40) : null,
            website: safeUrl(place.website),
            mapsUrl: safeUrl(place.google_maps_url),
            hasCoordinates: isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180,
            latitude: isFinite(lat) ? lat : null,
            longitude: isFinite(lng) ? lng : null
        };
    }

    function decodePolyline(encoded) {
        // Google encoded polyline (precision 5) -> [{lat, lng}]
        if (typeof encoded !== "string" || !encoded) return [];
        const points = [];
        let index = 0;
        let lat = 0;
        let lng = 0;
        while (index < encoded.length) {
            let shift = 0;
            let result = 0;
            let byte;
            do {
                if (index >= encoded.length) return points;
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            lat += (result & 1) ? ~(result >> 1) : (result >> 1);

            shift = 0;
            result = 0;
            do {
                if (index >= encoded.length) return points;
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            lng += (result & 1) ? ~(result >> 1) : (result >> 1);
            points.push({ lat: lat / 1e5, lng: lng / 1e5 });
        }
        return points;
    }

    // ------------------------------------------------------------
    // Backend erişimi
    // ------------------------------------------------------------

    function getBackendUrl() {
        try {
            if (typeof state.getBackendUrl === "function") {
                return String(state.getBackendUrl() || "").replace(/\/+$/, "");
            }
            if (typeof backendUrl !== "undefined" && backendUrl) {
                return String(backendUrl).replace(/\/+$/, "");
            }
        } catch (e) { /* yoksay */ }
        return "";
    }

    async function getToken() {
        try {
            if (typeof state.getToken === "function") return await state.getToken();
            if (typeof getAuthToken === "function") return await getAuthToken();
        } catch (e) { /* yoksay */ }
        return "";
    }

    function hasBackend() {
        return /^https?:\/\//i.test(getBackendUrl());
    }

    async function apiRequest(path, options) {
        const base = getBackendUrl();
        if (!base) throw new Error("Sunucu adresi tanımlı değil.");
        const token = await getToken();
        const opts = Object.assign({ method: "GET" }, options || {});
        opts.headers = Object.assign(
            { "Content-Type": "application/json" },
            token ? { Authorization: `Bearer ${token}` } : {},
            opts.headers || {}
        );
        if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
        const response = await fetch(`${base}${path}`, opts);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = (data && data.detail) || "Konum isteği tamamlanamadı.";
            const error = new Error(String(message));
            error.status = response.status;
            error.code = data && data.code;
            throw error;
        }
        return data;
    }

    // ------------------------------------------------------------
    // DOM yardımcıları
    // ------------------------------------------------------------

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = String(text);
        return node;
    }

    function linkEl(href, label) {
        const url = safeUrl(href);
        if (!url) return null;
        const link = el("a", "loc-link", label);
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        return link;
    }

    function toast(title, message, kind) {
        try {
            if (typeof showToast === "function") {
                showToast(title, message, kind || null, 6500);
                return;
            }
        } catch (e) { /* yoksay */ }
        console.info(`[LuminaLocation] ${title}: ${message}`);
    }

    function ensureStyles() {
        // Stil index.html içinde tanımlıdır; burada yalnızca varlığını kontrol ederiz.
        return true;
    }

    // ------------------------------------------------------------
    // Sunucu yapılandırması ve izin tercihi
    // ------------------------------------------------------------

    async function loadConfig() {
        if (!hasBackend()) {
            state.config = { maps: { provider: "none", available: false, reason: "Sunucu yok" } };
            return state.config;
        }
        try {
            const data = await apiRequest("/location/config");
            state.config = data;
            state.preference = data.preference || state.preference;
            await refreshBrowserPermission();
            return data;
        } catch (error) {
            state.lastError = error;
            state.config = {
                maps: { provider: "none", available: false, reason: "Sunucuya ulaşılamadı" }
            };
            return state.config;
        }
    }

    async function refreshBrowserPermission() {
        if (typeof navigator === "undefined" || !navigator.permissions || !navigator.permissions.query) {
            return "unknown";
        }
        try {
            const status = await navigator.permissions.query({ name: "geolocation" });
            state.browserPermission = status.state || "unknown";
            if (status && typeof status.addEventListener === "function") {
                status.addEventListener("change", () => {
                    state.browserPermission = status.state || "unknown";
                });
            }
        } catch (e) {
            state.browserPermission = "unknown";
        }
        return state.browserPermission;
    }

    async function savePreference(payload) {
        const data = await apiRequest("/location/preference", { method: "POST", body: payload });
        state.preference = data.preference || state.preference;
        return state.preference;
    }

    function currentPreference() {
        return state.preference || { permission: "unset", manual_city: null, manual_coordinates: null };
    }

    function getChatLocationPayload() {
        if (!state.sessionFix) return null;
        if (isPermissionBlocked(currentPreference())) return null;
        return {
            consent: true,
            label: state.sessionFix.label || "Mevcut konumun",
            coordinates: {
                latitude: roundCoordinate(state.sessionFix.latitude, 4),
                longitude: roundCoordinate(state.sessionFix.longitude, 4)
            }
        };
    }

    // ------------------------------------------------------------
    // İzin akışı
    // ------------------------------------------------------------

    async function persistPermission(permission) {
        if (!hasBackend()) return;
        try {
            state.preference = await savePreference({ permission });
        } catch (e) { /* tercih kaydı kritik değil */ }
    }

    function geolocationErrorMessage(error) {
        const code = error && error.code;
        if (code === 1) {
            return "Konum izni reddedildi. Tekrar sorulmayacak; şehir seçerek devam edebilirsin.";
        }
        if (code === 2) {
            return "Konum bilgisi alınamadı. Cihazın konum servisi kapalı olabilir; şehir seçebilirsin.";
        }
        if (code === 3) {
            return "Konum isteği zaman aşımına uğradı. Tekrar dene veya şehir seç.";
        }
        return "Konum alınamadı. Tekrar dene veya şehir seç.";
    }

    function requestDeviceLocation(options) {
        const opts = options || {};
        return new Promise(async (resolve) => {
            if (typeof navigator === "undefined" || !navigator.geolocation) {
                resolve({ ok: false, code: "unsupported", message: "Bu tarayıcı konum desteklemiyor. Şehir seçebilirsin." });
                return;
            }
            await refreshBrowserPermission();
            if (isPermissionBlocked(currentPreference()) || state.browserPermission === "denied") {
                resolve({
                    ok: false,
                    code: "denied",
                    message: "Konum izni reddedilmiş. Tekrar sorulmayacak; şehir seçerek devam edebilirsin."
                });
                return;
            }
            navigator.geolocation.getCurrentPosition(
                async (position) => {
                    const coords = position && position.coords ? position.coords : {};
                    const latitude = roundCoordinate(coords.latitude, 4);
                    const longitude = roundCoordinate(coords.longitude, 4);
                    if (latitude == null || longitude == null) {
                        resolve({ ok: false, code: "invalid", message: "Konum koordinatı geçersiz. Şehir seçebilirsin." });
                        return;
                    }
                    // Yalnızca bu oturum için bellekte tutulur.
                    state.sessionFix = {
                        latitude,
                        longitude,
                        label: opts.label || "Mevcut konumun",
                        at: Date.now()
                    };
                    await persistPermission("granted");
                    resolve({ ok: true, coordinates: { latitude, longitude }, label: state.sessionFix.label });
                },
                async (error) => {
                    const denied = error && error.code === 1;
                    if (denied) {
                        state.sessionFix = null;
                        state.browserPermission = "denied";
                        await persistPermission("denied");
                    }
                    resolve({ ok: false, code: denied ? "denied" : "error", message: geolocationErrorMessage(error) });
                },
                {
                    enableHighAccuracy: false,   // mahremiyet: düşük hassasiyet yeterli
                    timeout: 12000,
                    maximumAge: 5 * 60 * 1000
                }
            );
        });
    }

    async function revokePermission(options) {
        const opts = options || {};
        state.sessionFix = null;
        state.pendingRetryPrompt = null;
        if (hasBackend()) {
            try {
                state.preference = await savePreference({
                    permission: opts.clearManual ? "unset" : "unset",
                    clear_manual: Boolean(opts.clearManual)
                });
            } catch (e) {
                state.preference = Object.assign({}, currentPreference(), { permission: "unset", manual_city: opts.clearManual ? null : currentPreference().manual_city });
            }
        } else {
            state.preference = { permission: "unset", manual_city: opts.clearManual ? null : currentPreference().manual_city };
        }
        toast("Konum izni sıfırlandı", opts.clearManual ? "Cihaz izni ve manuel şehir temizlendi." : "Cihaz konumu artık kullanılmayacak.");
        return currentPreference();
    }

    // ------------------------------------------------------------
    // Şehir seçimi
    // ------------------------------------------------------------

    async function geocodeCity(query) {
        const text = String(query || "").trim();
        if (text.length < 2) throw new Error("En az 2 karakterlik bir şehir adı yaz.");
        if (!hasBackend()) throw new Error("Şehir arama için sunucu bağlantısı gerekli.");
        return await apiRequest(`/location/geocode?q=${encodeURIComponent(text)}&limit=6`);
    }

    async function chooseCity(city, coordinates) {
        const name = String(city || "").trim();
        if (!name) throw new Error("Şehir adı boş olamaz.");
        const payload = { permission: "manual", manual_city: name };
        if (coordinates && coordinates.latitude != null && coordinates.longitude != null) {
            payload.manual_coordinates = {
                latitude: roundCoordinate(coordinates.latitude, 5),
                longitude: roundCoordinate(coordinates.longitude, 5)
            };
        }
        if (!hasBackend()) throw new Error("Şehir kaydetmek için sunucu bağlantısı gerekli.");
        state.sessionFix = null;
        state.preference = await savePreference(payload);
        toast("Şehir kaydedildi", `${state.preference.manual_city || name} konumu kullanılacak.`);
        return state.preference;
    }

    async function chooseCityInteractive(selectedCity) {
        const city = selectedCity || await openCityPicker();
        if (!city) return null;
        const result = await geocodeCity(city);
        const match = (result.results || [])[0];
        if (!match) throw new Error("Şehir bulunamadı. Farklı bir ad dene.");
        return await chooseCity(match.label || match.name || city, {
            latitude: match.latitude,
            longitude: match.longitude
        });
    }

    // ------------------------------------------------------------
    // Modal: izin + şehir seçimi
    // ------------------------------------------------------------

    function getModalRoot() {
        let root = document.getElementById("loc-modal-root");
        if (root) return root;
        root = el("div", "loc-modal-overlay");
        root.id = "loc-modal-root";
        root.hidden = true;
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-modal", "true");
        root.setAttribute("aria-labelledby", "loc-modal-title");
        document.body.appendChild(root);
        root.addEventListener("click", (event) => {
            if (event.target === root) closeModal();
        });
        return root;
    }

    function closeModal() {
        const root = document.getElementById("loc-modal-root");
        if (root) root.hidden = true;
    }

    function onModalReady(callback) {
        state.onReady = typeof callback === "function" ? callback : null;
    }

    async function openPermissionModal(options) {
        const opts = options || {};
        state.pendingRetryPrompt = opts.retryPrompt || state.pendingRetryPrompt || null;
        const pref = currentPreference();
        const root = getModalRoot();
        root.innerHTML = "";
        const modal = el("div", "loc-modal");
        modal.setAttribute("role", "document");

        const header = el("div", "loc-modal-header");
        header.appendChild(el("h3", null, "Konum izni"));
        const closeBtn = el("button", "loc-modal-close", "✕");
        closeBtn.type = "button";
        closeBtn.setAttribute("aria-label", "Kapat");
        closeBtn.addEventListener("click", closeModal);
        header.appendChild(closeBtn);
        modal.appendChild(header);

        const body = el("div", "loc-modal-body");
        body.appendChild(el(
            "p",
            "loc-modal-text",
            "Lumina, hava durumu ve yakın mekân sonuçlarını gerçek verilerle göstermek için konumunu kullanabilir. " +
            "Cihaz konumu yalnızca açık izinle ve yalnızca bu oturum için alınır; kalıcı olarak saklanmaz. " +
            "İstersen cihaz konumu yerine şehir seçebilirsin."
        ));

        if (isPermissionBlocked(pref)) {
            body.appendChild(el(
                "div",
                "loc-warning",
                "Konum izni daha önce reddedildi veya kapatıldı. Bir daha sorulmayacak; şehir seçerek devam edebilirsin."
            ));
        } else {
            const allowBtn = el("button", "loc-primary-btn", "Cihaz konumumu kullan");
            allowBtn.type = "button";
            allowBtn.addEventListener("click", async () => {
                allowBtn.disabled = true;
                allowBtn.textContent = "Konum alınıyor…";
                const result = await requestDeviceLocation();
                allowBtn.disabled = false;
                allowBtn.textContent = "Cihaz konumumu kullan";
                if (result.ok) {
                    closeModal();
                    toast("Konum hazır", "Cihaz konumu yalnızca bu oturum için kullanılıyor.");
                    await afterLocationReady();
                } else {
                    const warn = body.querySelector(".loc-inline-status");
                    if (warn) warn.textContent = result.message;
                }
            });
            body.appendChild(allowBtn);
            body.appendChild(el("div", "loc-inline-status", ""));
        }

        body.appendChild(el("div", "loc-divider", "veya şehir seç"));
        const grid = el("div", "loc-city-grid");
        const cities = CITY_SUGGESTIONS.slice();
        const manual = pref.manual_city;
        if (manual && cities.indexOf(manual) === -1) cities.unshift(manual);
        cities.slice(0, 6).forEach((city) => {
            const btn = el("button", "loc-city-btn", city);
            btn.type = "button";
            btn.addEventListener("click", async () => {
                btn.disabled = true;
                try {
                    await chooseCityInteractive(city);
                    closeModal();
                    await afterLocationReady();
                } catch (error) {
                    toast("Şehir seçilemedi", error.message);
                } finally {
                    btn.disabled = false;
                }
            });
            grid.appendChild(btn);
        });
        body.appendChild(grid);

        const searchRow = el("div", "loc-city-search");
        const input = el("input", "loc-city-input");
        input.type = "search";
        input.placeholder = "Başka bir şehir yaz…";
        input.setAttribute("aria-label", "Şehir ara");
        const searchBtn = el("button", "loc-secondary-btn", "Ara");
        searchBtn.type = "button";
        const results = el("div", "loc-city-results");
        searchBtn.addEventListener("click", async () => {
            results.innerHTML = "";
            results.appendChild(el("div", "loc-inline-status", "Aranıyor…"));
            try {
                const data = await geocodeCity(input.value);
                results.innerHTML = "";
                const items = (data.results || []).slice(0, 6);
                if (!items.length) {
                    results.appendChild(el("div", "loc-inline-status", "Sonuç bulunamadı. Farklı bir ad dene."));
                    return;
                }
                items.forEach((item) => {
                    const btn = el("button", "loc-city-result", item.label || item.name);
                    btn.type = "button";
                    btn.addEventListener("click", async () => {
                        try {
                            await chooseCity(item.label || item.name, item);
                            closeModal();
                            await afterLocationReady();
                        } catch (error) {
                            toast("Şehir kaydedilemedi", error.message);
                        }
                    });
                    results.appendChild(btn);
                });
            } catch (error) {
                results.innerHTML = "";
                results.appendChild(el("div", "loc-warning", error.message));
            }
        });
        searchRow.appendChild(input);
        searchRow.appendChild(searchBtn);
        body.appendChild(searchRow);
        body.appendChild(results);

        if (pref.manual_city || pref.permission === "granted") {
            const resetBtn = el("button", "loc-link-btn", "Konum iznini sıfırla");
            resetBtn.type = "button";
            resetBtn.addEventListener("click", async () => {
                await revokePermission({ clearManual: false });
                closeModal();
            });
            body.appendChild(resetBtn);
        }

        const note = el("p", "loc-privacy-note", "Hassas koordinatlar loglanmaz. Şehir tercihleri yaklaşık 1 km hassasiyetle saklanır.");
        body.appendChild(note);
        modal.appendChild(body);
        root.appendChild(modal);
        root.hidden = false;
        return root;
    }

    function openCityPicker() {
        return new Promise((resolve) => {
            openPermissionModal({ retryPrompt: state.pendingRetryPrompt });
            state.cityPickerResolve = resolve;
        });
    }

    async function afterLocationReady() {
        const retryPrompt = state.pendingRetryPrompt;
        state.pendingRetryPrompt = null;
        if (typeof state.onReady === "function") {
            state.onReady(currentPreference());
        }
        if (retryPrompt && typeof global.quickAsk === "function") {
            global.quickAsk(retryPrompt);
        }
    }

    // ------------------------------------------------------------
    // Harita
    // ------------------------------------------------------------

    function loadScriptOnce(key, src, check) {
        if (check && check()) return Promise.resolve(true);
        if (state.mapLoaders[key]) return state.mapLoaders[key];
        state.mapLoaders[key] = new Promise((resolve) => {
            const script = document.createElement("script");
            script.src = src;
            script.async = true;
            script.defer = true;
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
        return state.mapLoaders[key];
    }

    function mapStatus(container, message, kind) {
        container.innerHTML = "";
        container.appendChild(el("div", kind === "error" ? "loc-warning" : "loc-inline-status", message));
    }

    async function renderMap(container, options) {
        const opts = options || {};
        if (!container) return null;
        container.innerHTML = "";
        container.classList.add("loc-map");
        const center = opts.center && isFinite(Number(opts.center.latitude))
            ? { latitude: Number(opts.center.latitude), longitude: Number(opts.center.longitude) }
            : null;
        const places = Array.isArray(opts.places) ? opts.places.filter((p) => p && p.hasCoordinates) : [];
        if (!center && !places.length) {
            mapStatus(container, "Harita için konum verisi yok.", "info");
            return null;
        }
        const mapsConfig = (state.config && state.config.maps) || {};
        const provider = mapsConfig.provider || "none";

        if (provider === "google" && mapsConfig.browser_key) {
            const ok = await loadScriptOnce(
                "google",
                `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsConfig.browser_key)}&language=tr&region=TR`,
                () => Boolean(global.google && global.google.maps)
            );
            if (ok && global.google && global.google.maps) {
                return renderGoogleMap(container, center || places[0], places, opts);
            }
            mapStatus(container, "Google Maps yüklenemedi. OpenStreetMap deneniyor…", "info");
        }

        const leafletOk = await loadScriptOnce(
            "leaflet",
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
            () => Boolean(global.L)
        );
        if (!leafletOk || !global.L) {
            mapStatus(
                container,
                "Harita kütüphanesi yüklenemedi. İşletme listesi ve mesafeler yine de geçerli; harita için internet bağlantısı gerekli.",
                "error"
            );
            return null;
        }
        return renderLeafletMap(container, center || places[0], places, opts);
    }

    function renderLeafletMap(container, center, places, opts) {
        try {
            const map = global.L.map(container, { zoomControl: true, attributionControl: true });
            const tileUrl = (state.config && state.config.maps && state.config.maps.tile_url)
                || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
            global.L.tileLayer(tileUrl, {
                maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıda bulunanlar'
            }).addTo(map);
            const points = [];
            places.forEach((place) => {
                const marker = global.L.circleMarker([place.latitude, place.longitude], {
                    radius: 7,
                    color: place.badge ? "#8b5cf6" : "#3b82f6",
                    weight: 2,
                    fillColor: place.badge ? "#8b5cf6" : "#3b82f6",
                    fillOpacity: 0.85
                }).addTo(map);
                const popup = el("div", "loc-popup");
                popup.appendChild(el("strong", null, place.name));
                popup.appendChild(el("div", null, place.address));
                popup.appendChild(el("div", null, place.ratingText));
                popup.appendChild(el("div", null, place.distanceText));
                if (place.mapsUrl) {
                    const link = linkEl(place.mapsUrl, "Google Maps'te aç");
                    if (link) popup.appendChild(link);
                }
                marker.bindPopup(popup);
                points.push([place.latitude, place.longitude]);
            });
            if (opts.polyline && opts.polyline.length) {
                const line = opts.polyline.map((p) => [p.lat, p.lng]);
                global.L.polyline(line, { color: "#8b5cf6", weight: 5, opacity: 0.8 }).addTo(map);
                points.push(line[0], line[line.length - 1]);
            }
            if (points.length > 1) {
                map.fitBounds(points, { padding: [28, 28] });
            } else {
                map.setView([center.latitude, center.longitude], 14);
            }
            setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 120);
            return map;
        } catch (e) {
            mapStatus(container, "Harita çizilemedi. Liste ve mesafeler geçerli.", "error");
            return null;
        }
    }

    function renderGoogleMap(container, center, places, opts) {
        try {
            const map = new global.google.maps.Map(container, {
                center: { lat: center.latitude, lng: center.longitude },
                zoom: 14,
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: true,
                mapId: (state.config.maps && state.config.maps.map_id) || undefined
            });
            const bounds = new global.google.maps.LatLngBounds();
            places.forEach((place) => {
                const marker = new global.google.maps.Marker({
                    position: { lat: place.latitude, lng: place.longitude },
                    map,
                    title: place.name
                });
                const info = el("div", "loc-popup");
                info.appendChild(el("strong", null, place.name));
                info.appendChild(el("div", null, place.address));
                info.appendChild(el("div", null, place.ratingText));
                info.appendChild(el("div", null, place.distanceText));
                if (place.mapsUrl) {
                    const link = linkEl(place.mapsUrl, "Google Maps'te aç");
                    if (link) info.appendChild(link);
                }
                const window_ = new global.google.maps.InfoWindow({ content: info });
                marker.addListener("click", () => window_.open({ anchor: marker, map }));
                bounds.extend({ lat: place.latitude, lng: place.longitude });
            });
            if (opts.polyline && opts.polyline.length) {
                const path = opts.polyline.map((p) => ({ lat: p.lat, lng: p.lng }));
                new global.google.maps.Polyline({ path, map, strokeColor: "#8b5cf6", strokeWeight: 5 });
                path.forEach((p) => bounds.extend(p));
            }
            if (places.length > 1 || (opts.polyline && opts.polyline.length > 1)) {
                map.fitBounds(bounds, 28);
            }
            return map;
        } catch (e) {
            mapStatus(container, "Google haritası çizilemedi. Liste ve mesafeler geçerli.", "error");
            return null;
        }
    }

    function mapProviderNote() {
        const mapsConfig = (state.config && state.config.maps) || {};
        if (!mapsConfig.provider || mapsConfig.provider === "none") {
            return "Harita sağlayıcısı yapılandırılmadı.";
        }
        if (mapsConfig.provider === "openstreetmap" && mapsConfig.reason) return mapsConfig.reason;
        return null;
    }

    // ------------------------------------------------------------
    // Smart UI kartları (yalnızca metin/öğe üretir; HTML enjeksiyonu yok)
    // ------------------------------------------------------------

    function sourceLine(block, extra) {
        const data = block.data || {};
        const line = el("div", "loc-source");
        line.appendChild(el("span", null, `Kaynak: ${data.source || "bilinmiyor"}`));
        line.appendChild(el("span", null, formatFetchedAt(data.fetched_at)));
        if (extra) line.appendChild(el("span", null, extra));
        return line;
    }

    function createLocationResults(block) {
        const data = block.data || {};
        const wrap = el("div", "loc-card");
        const meta = el("div", "loc-meta");
        meta.appendChild(el("span", null, data.location_label || "Seçilen konum"));
        if (data.radius_m) meta.appendChild(el("span", null, `Yarıçap: ${data.radius_m} m`));
        meta.appendChild(el("span", null, data.category_label || "Mekânlar"));
        wrap.appendChild(meta);

        const rankingLabels = [
            { key: "recommended", label: "Önerilen" },
            { key: "nearest", label: "En yakın" },
            { key: "top_rated", label: "En yüksek puanlı" }
        ];
        const tabs = el("div", "loc-tabs");
        tabs.setAttribute("role", "tablist");
        const listWrap = el("div", "loc-list");
        const mapWrap = el("div", "loc-map-wrap");
        let active = "recommended";

        const draw = () => {
            tabs.querySelectorAll(".loc-tab").forEach((tab) => {
                const on = tab.dataset.ranking === active;
                tab.classList.toggle("active", on);
                tab.setAttribute("aria-selected", on ? "true" : "false");
            });
            listWrap.innerHTML = "";
            const rows = pickRankingList(data, active).map(buildPlaceRowModel).filter(Boolean);
            if (!rows.length) {
                listWrap.appendChild(el(
                    "div",
                    "loc-empty",
                    active === "recommended"
                        ? "Bu arama için işletme bulunamadı. Yarıçapı artırmayı veya farklı bir kategori denemeyi öner."
                        : "Bu sıralama için yeterli veri yok."
                ));
            } else {
                rows.forEach((row, index) => {
                    const item = el("div", "loc-item");
                    const head = el("div", "loc-item-head");
                    const title = el("div", "loc-item-title");
                    title.appendChild(el("span", "loc-index", `${index + 1}.`));
                    title.appendChild(el("strong", null, row.name));
                    if (row.badge) title.appendChild(el("span", "loc-badge", row.badge));
                    head.appendChild(title);
                    item.appendChild(head);

                    const facts = el("div", "loc-facts");
                    facts.appendChild(el("span", "loc-rating", row.ratingText));
                    facts.appendChild(el("span", "loc-distance", row.distanceText));
                    if (row.priceLevel) facts.appendChild(el("span", "loc-price", row.priceLevel));
                    item.appendChild(facts);

                    item.appendChild(el("div", "loc-address", row.address));

                    const actions = el("div", "loc-actions");
                    if (row.mapsUrl) {
                        const mapsLink = linkEl(row.mapsUrl, "Haritada aç");
                        if (mapsLink) actions.appendChild(mapsLink);
                    }
                    if (row.website) {
                        const site = linkEl(row.website, "Web sitesi");
                        if (site) actions.appendChild(site);
                    }
                    if (row.phone) actions.appendChild(el("span", "loc-phone", row.phone));
                    const routeBtn = el("button", "loc-link-btn", "Yol tarifi");
                    routeBtn.type = "button";
                    routeBtn.addEventListener("click", () => {
                        if (typeof global.quickAsk === "function") global.quickAsk(`${row.name} yol tarifi`);
                    });
                    actions.appendChild(routeBtn);
                    item.appendChild(actions);
                    listWrap.appendChild(item);
                });
            }
            mapWrap.innerHTML = "";
            renderMap(mapWrap, {
                center: {
                    latitude: Number(data.places && data.places[0] ? data.places[0].latitude : 0),
                    longitude: Number(data.places && data.places[0] ? data.places[0].longitude : 0)
                },
                places: rows
            });
        };

        rankingLabels.forEach((entry) => {
            const tab = el("button", "loc-tab", entry.label);
            tab.type = "button";
            tab.dataset.ranking = entry.key;
            tab.setAttribute("role", "tab");
            tab.addEventListener("click", () => { active = entry.key; draw(); });
            tabs.appendChild(tab);
        });
        wrap.appendChild(tabs);
        wrap.appendChild(mapWrap);
        wrap.appendChild(listWrap);
        if (data.ranking_explanation) {
            wrap.appendChild(el("div", "loc-ranking-note", data.ranking_explanation));
        }
        if (data.notice) wrap.appendChild(el("div", "loc-warning", data.notice));
        wrap.appendChild(sourceLine(block));
        const providerNote = mapProviderNote();
        if (providerNote) wrap.appendChild(el("div", "loc-note", providerNote));
        draw();
        return wrap;
    }

    function createWeatherForecast(block) {
        const data = block.data || {};
        const wrap = el("div", "loc-card weather-card");
        const current = data.current || {};
        const nowRow = el("div", "weather-now");
        nowRow.appendChild(el("div", "weather-icon", current.icon || "🌡️"));
        const nowMain = el("div", "weather-main");
        nowMain.appendChild(el("div", "weather-temp", current.temperature == null ? "—" : `${current.temperature}°C`));
        nowMain.appendChild(el("div", "weather-condition", current.condition || "Bilinmiyor"));
        if (current.apparent_temperature != null) {
            nowMain.appendChild(el("div", "weather-feels", `Hissedilen ${current.apparent_temperature}°C`));
        }
        nowRow.appendChild(nowMain);
        wrap.appendChild(nowRow);

        const metrics = el("div", "weather-metrics");
        const metric = (label, value) => {
            if (value == null || value === "") return;
            const box = el("div", "weather-metric");
            box.appendChild(el("span", "weather-metric-label", label));
            box.appendChild(el("strong", null, String(value)));
            metrics.appendChild(box);
        };
        metric("Nem", current.humidity == null ? null : `%${current.humidity}`);
        metric("Rüzgar", current.wind_speed == null ? null : `${current.wind_speed} km/sa`);
        metric("Yağış olasılığı", current.precipitation_probability == null ? null : `%${current.precipitation_probability}`);
        metric("Yağış", current.precipitation == null ? null : `${current.precipitation} mm`);
        if (metrics.children.length) wrap.appendChild(metrics);

        if (Array.isArray(data.hourly) && data.hourly.length) {
            const hours = el("div", "weather-hours");
            data.hourly.slice(0, 8).forEach((hour) => {
                const box = el("div", "weather-hour");
                box.appendChild(el("span", null, (hour.time || "").slice(-5) || "—"));
                box.appendChild(el("span", "weather-hour-icon", hour.icon || "·"));
                box.appendChild(el("strong", null, hour.temperature == null ? "—" : `${hour.temperature}°`));
                if (hour.precipitation_probability != null) {
                    box.appendChild(el("span", "weather-hour-rain", `%${hour.precipitation_probability}`));
                }
                hours.appendChild(box);
            });
            wrap.appendChild(hours);
        }

        if (Array.isArray(data.daily) && data.daily.length) {
            const daily = el("div", "weather-daily");
            data.daily.slice(0, 7).forEach((day) => {
                const row = el("div", "weather-day");
                row.appendChild(el("span", "weather-day-name", day.weekday || day.date || ""));
                row.appendChild(el("span", "weather-day-icon", day.icon || "·"));
                row.appendChild(el("span", "weather-day-cond", day.condition || ""));
                const range = el("span", "weather-range");
                range.appendChild(el("span", "weather-min", day.temp_min == null ? "—" : `${day.temp_min}°`));
                const bar = el("span", "weather-bar");
                const max = Number(day.temp_max);
                const min = Number(day.temp_min);
                if (isFinite(max) && isFinite(min) && max !== min) {
                    const pct = Math.max(8, Math.min(100, ((max - min) / 40) * 100 + 10));
                    const fill = el("span", "weather-bar-fill");
                    fill.style.width = `${pct}%`;
                    bar.appendChild(fill);
                }
                range.appendChild(bar);
                range.appendChild(el("span", "weather-max", day.temp_max == null ? "—" : `${day.temp_max}°`));
                row.appendChild(range);
                if (day.precipitation_probability != null) {
                    row.appendChild(el("span", "weather-day-rain", `%${day.precipitation_probability}`));
                }
                daily.appendChild(row);
            });
            wrap.appendChild(daily);
        }

        if (data.warning || data.stale) {
            wrap.appendChild(el(
                "div",
                data.stale ? "loc-warning" : "loc-note",
                data.stale ? (data.warning || "Bu veri önbellekten geldi ve güncel değil.") : data.warning
            ));
        }
        const license = data.source_license ? `Lisans: ${data.source_license}` : null;
        wrap.appendChild(sourceLine(block, license));
        return wrap;
    }

    function createRouteInfo(block) {
        const data = block.data || {};
        const wrap = el("div", "loc-card route-card");
        const summary = el("div", "route-summary");
        const summaryItem = (label, value) => {
            const box = el("div", "route-summary-item");
            box.appendChild(el("span", "route-summary-label", label));
            box.appendChild(el("strong", null, value));
            summary.appendChild(box);
        };
        summaryItem("Mesafe", data.distance_km == null ? "—" : `${data.distance_km} km`);
        summaryItem("Süre", data.duration_minutes == null ? "—" : `${data.duration_minutes} dk`);
        summaryItem("Mod", data.travel_mode_label || data.travel_mode || "—");
        if (data.direct_distance_km != null) {
            summaryItem("Kuş uçuşu", `${data.direct_distance_km} km`);
        }
        wrap.appendChild(summary);

        const mapWrap = el("div", "loc-map-wrap");
        wrap.appendChild(mapWrap);
        const originPoint = data.origin && isFinite(Number(data.origin.latitude))
            ? { latitude: Number(data.origin.latitude), longitude: Number(data.origin.longitude) }
            : null;
        const destinationPoint = data.destination && isFinite(Number(data.destination.latitude))
            ? { latitude: Number(data.destination.latitude), longitude: Number(data.destination.longitude) }
            : null;
        const routePlaces = [];
        if (originPoint) {
            routePlaces.push({
                name: data.origin_label || "Başlangıç",
                address: "", ratingText: "", distanceText: "",
                latitude: originPoint.latitude, longitude: originPoint.longitude,
                hasCoordinates: true, badge: "Başlangıç"
            });
        }
        if (destinationPoint) {
            routePlaces.push({
                name: data.destination_label || "Hedef",
                address: "", ratingText: "", distanceText: "",
                latitude: destinationPoint.latitude, longitude: destinationPoint.longitude,
                hasCoordinates: true, badge: "Hedef"
            });
        }
        const polylinePoints = typeof data.encoded_polyline === "string"
            ? decodePolyline(data.encoded_polyline).map((p) => ({ lat: p.lat, lng: p.lng }))
            : [];
        renderMap(mapWrap, {
            center: originPoint || destinationPoint || null,
            places: routePlaces,
            polyline: polylinePoints
        });

        if (Array.isArray(data.steps) && data.steps.length) {
            const list = el("ol", "route-steps");
            data.steps.forEach((step) => {
                const item = el("li", "route-step");
                item.appendChild(el("span", "route-step-text", step.instruction || ""));
                const facts = [];
                if (step.distance_m != null) facts.push(`${step.distance_m} m`);
                if (step.duration_seconds != null) facts.push(`${Math.round(step.duration_seconds / 60)} dk`);
                if (facts.length) item.appendChild(el("span", "route-step-meta", facts.join(" · ")));
                list.appendChild(item);
            });
            wrap.appendChild(list);
        } else {
            wrap.appendChild(el("div", "loc-note", "Adım adım tarif sağlayıcıdan gelmedi. Mesafe ve süre yine de geçerli."));
        }

        const actions = el("div", "loc-actions");
        const mapsLink = linkEl(data.google_maps_url, "Google Maps'te aç");
        if (mapsLink) actions.appendChild(mapsLink);
        wrap.appendChild(actions);
        wrap.appendChild(sourceLine(block));
        return wrap;
    }

    function createLocationRequest(block) {
        const data = block.data || {};
        const wrap = el("div", "loc-card loc-request");
        wrap.appendChild(el("p", "loc-request-reason", data.reason || "Konum bilgisi gerekli."));
        if (data.permission_state === "denied" || data.permission_state === "off") {
            wrap.appendChild(el("div", "loc-warning", "Konum izni reddedildi. Bir daha sorulmayacak; şehir seçebilirsin."));
        }
        const actions = el("div", "loc-actions");
        if (data.allow_device && data.permission_state !== "denied" && data.permission_state !== "off") {
            const deviceBtn = el("button", "loc-primary-btn", "Cihaz konumumu kullan");
            deviceBtn.type = "button";
            deviceBtn.addEventListener("click", async () => {
                deviceBtn.disabled = true;
                const result = await requestDeviceLocation();
                deviceBtn.disabled = false;
                if (result.ok) {
                    toast("Konum hazır", "Cihaz konumu yalnızca bu oturum için kullanılıyor.");
                    await afterLocationReady();
                } else {
                    toast("Konum alınamadı", result.message);
                }
            });
            actions.appendChild(deviceBtn);
        }
        const cityBtn = el("button", "loc-secondary-btn", "Şehir seç");
        cityBtn.type = "button";
        cityBtn.addEventListener("click", () => {
            // Sunucu şemasında retry_prompt yok; neden metni yeniden deneme ipucu olarak kullanılır.
            const retryPrompt = data.reason || null;
            state.pendingRetryPrompt = retryPrompt;
            openPermissionModal({ retryPrompt });
        });
        actions.appendChild(cityBtn);
        wrap.appendChild(actions);

        if (Array.isArray(data.suggested_cities) && data.suggested_cities.length) {
            const grid = el("div", "loc-city-grid");
            data.suggested_cities.slice(0, 6).forEach((city) => {
                const btn = el("button", "loc-city-btn", city);
                btn.type = "button";
                btn.addEventListener("click", async () => {
                    btn.disabled = true;
                    try {
                        await chooseCityInteractive(city);
                        await afterLocationReady();
                    } catch (error) {
                        toast("Şehir seçilemedi", error.message);
                    } finally {
                        btn.disabled = false;
                    }
                });
                grid.appendChild(btn);
            });
            wrap.appendChild(grid);
        }
        return wrap;
    }

    function createLocationInfo(block) {
        const data = block.data || {};
        const wrap = el("div", "loc-card");
        const header = el("div", "loc-info-head");
        header.appendChild(el("strong", null, data.label || "Konum"));
        header.appendChild(el("span", "loc-badge", data.source === "device" ? "Cihaz" : "Manuel şehir"));
        wrap.appendChild(header);
        const coords = el("div", "loc-coords");
        coords.textContent = `${Number(data.latitude).toFixed(3)}, ${Number(data.longitude).toFixed(3)}`;
        wrap.appendChild(coords);
        if (data.note) wrap.appendChild(el("div", "loc-note", data.note));
        const mapWrap = el("div", "loc-map-wrap");
        wrap.appendChild(mapWrap);
        renderMap(mapWrap, {
            center: { latitude: data.latitude, longitude: data.longitude },
            places: [{ name: data.label, address: data.note || "", ratingText: "", distanceText: "", latitude: data.latitude, longitude: data.longitude, hasCoordinates: true, badge: null }]
        });
        wrap.appendChild(el("p", "loc-privacy-note", "Koordinatlar yaklaşık 110 m hassasiyetle gösterilir. Cihaz konumu kalıcı olarak saklanmaz."));
        return wrap;
    }

    // ------------------------------------------------------------
    // Başlatma
    // ------------------------------------------------------------

    function configure(options) {
        const opts = options || {};
        if (opts.getBackendUrl) state.getBackendUrl = opts.getBackendUrl;
        if (opts.getToken) state.getToken = opts.getToken;
        if (opts.onReady) state.onReady = opts.onReady;
        state.configured = true;
        return true;
    }

    async function init() {
        if (state.initialized) return state.config;
        state.initialized = true;
        ensureStyles();
        await refreshBrowserPermission();
        await loadConfig();
        const button = document.getElementById("location-btn");
        if (button) {
            button.addEventListener("click", () => {
                if (!hasBackend()) {
                    toast("Sunucu gerekli", "Canlı konum, hava durumu ve harita için backend bağlantısı gerekli.");
                    return;
                }
                openPermissionModal({});
            });
        }
        return state.config;
    }

    const api = {
        init,
        configure,
        loadConfig,
        getChatLocationPayload,
        requestDeviceLocation,
        revokePermission,
        chooseCity,
        chooseCityInteractive,
        geocodeCity,
        openPermissionModal,
        closeModal,
        refreshBrowserPermission,
        currentPreference,
        getState: () => ({
            preference: currentPreference(),
            browserPermission: state.browserPermission,
            hasSessionFix: Boolean(state.sessionFix),
            maps: (state.config && state.config.maps) || null
        }),
        createLocationResults,
        createWeatherForecast,
        createRouteInfo,
        createLocationRequest,
        createLocationInfo,
        renderMap,
        // Saf yardımcılar (testler için)
        __test: {
            roundCoordinate,
            safeUrl,
            formatDistance,
            formatRating,
            formatFetchedAt,
            isPermissionBlocked,
            canAskPermission,
            pickRankingList,
            buildPlaceRowModel,
            decodePolyline
        }
    };

    global.LuminaLocation = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
