console.log("🔥 CONTENT JS RODANDO");
(() => {

console.log("🔥 Crunchy Dub Detector v14.0 - SMART LOGIC + LOCAL DB");

// ===================== CONFIG =====================
const DATABASE_URL = chrome.runtime.getURL("database.json");
const CACHE_KEY = "crunchydub_cache";
const CACHE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 dias (atualização mensal)

// Pesos atualizados (AniList com mais peso)
const API_WEIGHTS = {
    anilist: 0.90,
    kitsu:   0.60,
    mal:     0.50,
    tmdb:    0.70,
    simkl:   0.80,
};

// ===================== STATE =====================
let running = false;
const processedCards = new WeakSet();
let localDatabase = {};
let learnedDatabase = {};
const processingCache = new Map();

// ===================== DATABASE =====================
async function loadDatabase() {
    try {
        const res = await fetch(DATABASE_URL);
        if (res.ok) {
            localDatabase = await res.json();
            console.log(`📚 Database manual: ${Object.keys(localDatabase).length} animes`);
        }
    } catch (e) {
        console.warn("❌ Falha ao carregar database.json", e);
        localDatabase = {};
    }

    try {
        const result = await chrome.storage.local.get(CACHE_KEY);
        learnedDatabase = result[CACHE_KEY] || {};
        console.log(`🧠 Database aprendido: ${Object.keys(learnedDatabase).length} animes`);
    } catch {
        learnedDatabase = {};
    }
}

async function saveLearnedEntry(normalizedTitle, entry) {
    learnedDatabase[normalizedTitle] = { ...entry, learnedAt: Date.now() };
    try {
        await chrome.storage.local.set({ [CACHE_KEY]: learnedDatabase });
    } catch (e) {
        console.warn("⚠️ Não foi possível salvar no storage:", e);
    }
}

// ===================== UTIL =====================
function normalizeTitle(title) {
    return (title || "")
        .toLowerCase()
        .replace(/[\(\[].*?[\)\]]/g, "")
        .replace(/dub|sub|legendado|dublado|hd/gi, "")
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function extractTitle(card, link) {
    return (
        link?.getAttribute("aria-label") ||
        link?.getAttribute("title") ||
        card.querySelector('[data-t="title"]')?.textContent ||
        card.querySelector("h3")?.textContent ||
        card.textContent ||
        ""
    ).trim();
}

function isPtLang(str) {
    return /portuguese|portugu[eê]s|pt[-_]?br|pt[-_]?pt|\bpt\b/i.test(str || "");
}

function fetchWithTimeout(url, options = {}, ms = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

// ===== FUNÇÕES DE RATING =====
function normalizeAniListRating(media) {
    const score = (media?.averageScore ?? 0) / 10;
    const pop = media?.popularity ?? 0;
    const popScore = Math.min(10, Math.log10(pop + 1) * 2);
    return { score, popularity: popScore };
}

function getScoreColor(score) {
    const hue = 120 * (score / 10);
    return `hsl(${hue}, 100%, 50%)`;
}

// ===================== FUNÇÃO CRUNCHYROLL (via background) =====================
async function fetchCrunchyLanguages(seriesUrl) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(
            {
                action: "getCrunchyAudio",
                url: seriesUrl
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.warn("⚠️ Erro ao comunicar com background:", chrome.runtime.lastError);
                    resolve(null);
                    return;
                }

                console.log("📥 Resposta do background:", response);

                if (!response?.success || !response.audio?.found) {
                    console.log("❌ Não encontrou idiomas");
                    resolve({
                        source: "crunchy-html",
                        hasDubOnCrunchy: false,
                        audio: [],
                        subtitles: [],
                        platforms: ["crunchyroll"],
                        confidence: 0
                    });
                    return;
                }

                const audio = (response.audio.text || "")
                    .replace(/^Áudio:\s*/i, "")
                    .split(",")
                    .map(x => x.trim())
                    .filter(Boolean);

                console.log("🎵 Idiomas encontrados:", audio);

                resolve({
                    source: "crunchy-html",
                    hasDubOnCrunchy: audio.some(a =>
                        /portugu[eê]s|portuguese/i.test(a)
                    ),
                    audio,
                    subtitles: [],
                    platforms: ["crunchyroll"],
                    confidence: audio.length ? 1.0 : 0
                });
            }
        );
    });
}

// ===================== APIs =====================

// AniList (principal fonte)
async function fetchAniList(title) {
    try {
        const res = await fetchWithTimeout("https://graphql.anilist.co", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: `query($s:String){
                    Media(search:$s, type:ANIME){
                        title{ romaji english }
                        externalLinks{ site url language type }
                        averageScore
                        popularity
                    }
                }`,
                variables: { s: title }
            })
        }, 6000);

        const data = await res.json();
        if (data?.errors) return null;

        const media = data?.data?.Media;
        if (!media) return null;

        const rating = normalizeAniListRating(media);

        const links = media.externalLinks || [];

        const hasDubOnCrunchy = links.some(l =>
            l.type === "STREAMING" &&
            (l.site || "").toLowerCase().includes("crunchyroll") &&
            isPtLang(l.language || "")
        );

        const dubOnNetflix = links.some(l =>
            l.type === "STREAMING" &&
            (l.site || "").toLowerCase().includes("netflix") &&
            isPtLang(l.language || "")
        );
        const dubOnPrime = links.some(l =>
            l.type === "STREAMING" &&
            ((l.site || "").toLowerCase().includes("amazon") || (l.site || "").toLowerCase().includes("prime")) &&
            isPtLang(l.language || "")
        );
        const dubOnDisney = links.some(l =>
            l.type === "STREAMING" &&
            (l.site || "").toLowerCase().includes("disney") &&
            isPtLang(l.language || "")
        );
        const dubOnHbo = links.some(l =>
            l.type === "STREAMING" &&
            ((l.site || "").toLowerCase().includes("hbo") || (l.site || "").toLowerCase().includes("max")) &&
            isPtLang(l.language || "")
        );
        const dubOnApple = links.some(l =>
            l.type === "STREAMING" &&
            (l.site || "").toLowerCase().includes("apple") &&
            isPtLang(l.language || "")
        );
        const dubOnYoutube = links.some(l =>
            l.type === "STREAMING" &&
            (l.site || "").toLowerCase().includes("youtube") &&
            isPtLang(l.language || "")
        );
        const dubOnParamount = links.some(l =>
            l.type === "STREAMING" &&
            (l.site || "").toLowerCase().includes("paramount") &&
            isPtLang(l.language || "")
        );
        const dubOnGloboplay = links.some(l =>
            l.type === "STREAMING" &&
            (l.site || "").toLowerCase().includes("globoplay") &&
            isPtLang(l.language || "")
        );
        const dubOnHidive = links.some(l =>
            l.type === "STREAMING" &&
            (l.site || "").toLowerCase().includes("hidive") &&
            isPtLang(l.language || "")
        );

        const platforms = extractPlatformsFromLinks(links);

        return {
            source: "anilist",
            hasDubOnCrunchy,
            dubElsewhere: {
                netflix: dubOnNetflix,
                prime: dubOnPrime,
                disney: dubOnDisney,
                hbo: dubOnHbo,
                apple: dubOnApple,
                youtube: dubOnYoutube,
                paramount: dubOnParamount,
                globoplay: dubOnGloboplay,
                hidive: dubOnHidive
            },
            platforms,
            confidence: links.some(l => l.language) ? 0.90 : 0.50,
            rating
        };
    } catch { return null; }
}

// Kitsu (agora com rating)
async function fetchKitsu(title) {
    try {
        const res = await fetchWithTimeout(
            `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`,
            { headers: { "Accept": "application/vnd.api+json" } },
            6000
        );
        const data = await res.json();
        const anime = data?.data?.[0];
        if (!anime) return null;

        const avgRating = anime.attributes?.averageRating;
        let kitsuScore = 0;
        if (avgRating) {
            kitsuScore = parseFloat(avgRating) / 10;
        }
        const rating = { score: kitsuScore, popularity: 0 };

        const linksRes = await fetchWithTimeout(
            `https://kitsu.io/api/edge/anime/${anime.id}/streaming-links?include=streamer`,
            { headers: { "Accept": "application/vnd.api+json" } },
            6000
        );
        const linksData = await linksRes.json();
        const streamers = (linksData?.included || []).map(s =>
            (s?.attributes?.siteName || "").toLowerCase()
        );

        const platforms = [];
        if (streamers.some(s => s.includes("crunchyroll"))) platforms.push("crunchyroll");
        if (streamers.some(s => s.includes("netflix")))     platforms.push("netflix");
        if (streamers.some(s => s.includes("prime") || s.includes("amazon"))) platforms.push("prime");
        if (streamers.some(s => s.includes("disney")))      platforms.push("disney");
        if (streamers.some(s => s.includes("hbo") || s.includes("max"))) platforms.push("hbo");
        if (streamers.some(s => s.includes("apple")))       platforms.push("apple");
        if (streamers.some(s => s.includes("youtube")))     platforms.push("youtube");
        if (streamers.some(s => s.includes("paramount")))   platforms.push("paramount");
        if (streamers.some(s => s.includes("globoplay")))   platforms.push("globoplay");
        if (streamers.some(s => s.includes("hidive")))      platforms.push("hidive");

        return {
            source: "kitsu",
            hasDubOnCrunchy: null,
            dubElsewhere: null,
            platforms,
            confidence: 0,
            rating
        };
    } catch { return null; }
}

// MyAnimeList (Jikan) com rating
async function fetchMAL(title) {
    try {
        const res = await fetchWithTimeout(
            `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=1`,
            {}, 6000
        );
        const data = await res.json();
        const anime = data?.data?.[0];
        if (!anime) return null;

        const malScore = anime.score ?? 0;
        const rating = { score: malScore, popularity: 0 };

        const extRes = await fetchWithTimeout(
            `https://api.jikan.moe/v4/anime/${anime.mal_id}/external`,
            {}, 6000
        );
        const extData = await extRes.json();
        const links = (extData?.data || []).map(l => (l.url || "").toLowerCase());

        const platforms = [];
        if (links.some(l => l.includes("crunchyroll"))) platforms.push("crunchyroll");
        if (links.some(l => l.includes("netflix")))     platforms.push("netflix");
        if (links.some(l => l.includes("prime") || l.includes("amazon"))) platforms.push("prime");
        if (links.some(l => l.includes("disney")))      platforms.push("disney");
        if (links.some(l => l.includes("hbo") || l.includes("max"))) platforms.push("hbo");
        if (links.some(l => l.includes("apple")))       platforms.push("apple");
        if (links.some(l => l.includes("youtube")))     platforms.push("youtube");
        if (links.some(l => l.includes("paramount")))   platforms.push("paramount");
        if (links.some(l => l.includes("globoplay")))   platforms.push("globoplay");
        if (links.some(l => l.includes("hidive")))      platforms.push("hidive");

        return {
            source: "mal",
            hasDubOnCrunchy: null,
            dubElsewhere: null,
            platforms,
            confidence: 0,
            rating
        };
    } catch { return null; }
}

// TMDb com rating
async function fetchTMDB(title) {
    const TMDB_API_KEY = ""; // insira sua chave
    if (!TMDB_API_KEY) return null;
    try {
        const searchRes = await fetchWithTimeout(
            `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=pt-BR`,
            {}, 6000
        );
        const searchData = await searchRes.json();
        const show = searchData?.results?.[0];
        if (!show) return null;

        const tmdbScore = show.vote_average ?? 0;
        const rating = { score: tmdbScore, popularity: 0 };

        const provRes = await fetchWithTimeout(
            `https://api.themoviedb.org/3/tv/${show.id}/watch/providers?api_key=${TMDB_API_KEY}`,
            {}, 6000
        );
        const provData = await provRes.json();
        const br = provData?.results?.BR || {};
        const all = [...(br.flatrate || []), ...(br.ads || [])].map(p => (p.provider_name || "").toLowerCase());

        const platforms = [];
        if (all.some(p => p.includes("crunchyroll"))) platforms.push("crunchyroll");
        if (all.some(p => p.includes("netflix")))     platforms.push("netflix");
        if (all.some(p => p.includes("prime") || p.includes("amazon"))) platforms.push("prime");
        if (all.some(p => p.includes("disney")))      platforms.push("disney");
        if (all.some(p => p.includes("hbo") || p.includes("max"))) platforms.push("hbo");
        if (all.some(p => p.includes("apple")))       platforms.push("apple");
        if (all.some(p => p.includes("youtube")))     platforms.push("youtube");
        if (all.some(p => p.includes("paramount")))   platforms.push("paramount");
        if (all.some(p => p.includes("globoplay")))   platforms.push("globoplay");
        if (all.some(p => p.includes("hidive")))      platforms.push("hidive");

        return {
            source: "tmdb",
            hasDubOnCrunchy: null,
            dubElsewhere: null,
            platforms,
            confidence: 0,
            rating
        };
    } catch { return null; }
}

// Simkl com rating
async function fetchSimkl(title) {
    const SIMKL_API_KEY = ""; // insira sua chave (gratuita em simkl.com)
    if (!SIMKL_API_KEY) return null;
    try {
        const res = await fetchWithTimeout(
            `https://api.simkl.com/search/anime?q=${encodeURIComponent(title)}`,
            {
                headers: { "simkl-api-key": SIMKL_API_KEY }
            },
            6000
        );
        const data = await res.json();
        if (!data?.length) return null;

        const first = data[0];
        let simklScore = 0;
        if (first.rating) {
            simklScore = first.rating;
        }
        const rating = { score: simklScore, popularity: 0 };

        const platforms = [];
        if (first.sources) {
            for (const src of first.sources) {
                const name = (src.name || "").toLowerCase();
                if (name.includes("crunchyroll")) platforms.push("crunchyroll");
                if (name.includes("netflix")) platforms.push("netflix");
                if (name.includes("prime") || name.includes("amazon")) platforms.push("prime");
                if (name.includes("disney")) platforms.push("disney");
                if (name.includes("hbo") || name.includes("max")) platforms.push("hbo");
                if (name.includes("apple")) platforms.push("apple");
                if (name.includes("youtube")) platforms.push("youtube");
                if (name.includes("paramount")) platforms.push("paramount");
                if (name.includes("globoplay")) platforms.push("globoplay");
                if (name.includes("hidive")) platforms.push("hidive");
            }
        }

        if (!platforms.length && first.external_ids) {
            const ids = first.external_ids;
            if (ids.netflix_id) platforms.push("netflix");
            if (ids.crunchyroll_id) platforms.push("crunchyroll");
            if (ids.prime_id) platforms.push("prime");
            if (ids.disney_id) platforms.push("disney");
            if (ids.hbo_id) platforms.push("hbo");
            if (ids.apple_id) platforms.push("apple");
        }

        return {
            source: "simkl",
            hasDubOnCrunchy: null,
            dubElsewhere: null,
            platforms: [...new Set(platforms)],
            confidence: 0.5,
            rating
        };
    } catch { return null; }
}

function extractPlatformsFromLinks(links) {
    const platforms = new Set();
    for (const link of links) {
        const combined = ((link.site || "") + " " + (link.url || "")).toLowerCase();
        if (combined.includes("crunchyroll")) platforms.add("crunchyroll");
        if (combined.includes("netflix"))     platforms.add("netflix");
        if (combined.includes("prime") || combined.includes("amazon")) platforms.add("prime");
        if (combined.includes("disney"))      platforms.add("disney");
        if (combined.includes("hbo") || combined.includes("max")) platforms.add("hbo");
        if (combined.includes("apple"))       platforms.add("apple");
        if (combined.includes("youtube"))     platforms.add("youtube");
        if (combined.includes("paramount"))   platforms.add("paramount");
        if (combined.includes("globoplay"))   platforms.add("globoplay");
        if (combined.includes("hidive"))      platforms.add("hidive");
    }
    return [...platforms];
}

// ===================== LÓGICA PRINCIPAL =====================
async function resolveAnime(title, seriesUrl = null) {
    const key = normalizeTitle(title);

    if (processingCache.has(key)) {
        return await processingCache.get(key);
    }

    const promise = (async () => {
        // 1. Database manual
        if (localDatabase[key]) {
            const db = localDatabase[key];
            console.log(`📚 [DB MANUAL] ${key}`);
            return {
                source: "manual",
                hasDubOnCrunchy: db.hasDubOnCrunchy ?? false,
                dubElsewhere: db.dubElsewhere || {},
                platforms: db.platforms || [],
                confidence: 1.0,
                audio: db.audio || [],
                subtitles: db.subtitles || [],
                rating: db.rating || null
            };
        }

        // 2. Database aprendido (cache de 30 dias)
        const learned = learnedDatabase[key];
        if (learned) {
            const age = Date.now() - (learned.learnedAt || 0);
            if (age < CACHE_DURATION) {
                console.log(`🧠 [DB APRENDIDO] ${key} (${Math.floor(age / (24*60*60*1000))} dias atrás)`);
                return learned;
            } else {
                console.log(`⏰ [CACHE EXPIRADO] ${key} - ${Math.floor(age / (24*60*60*1000))} dias, revalidando...`);
            }
        }

        // 3. Crunchyroll via background (sempre busca, mas NÃO interrompe o fluxo)
        let crunchyResult = null;
        if (seriesUrl) {
            try {
                console.log(`🍊 [CRUNCHY BACKGROUND] ${key}`);
                crunchyResult = await fetchCrunchyLanguages(seriesUrl);
                if (crunchyResult?.audio?.length) {
                    crunchyResult.learnedAt = Date.now();
                    console.log(`🍊 ${key}:`, crunchyResult);
                    await saveLearnedEntry(key, crunchyResult);
                    // NÃO retorna cedo mesmo se tiver dublagem
                }
            } catch (err) {
                console.warn(`⚠️ Crunchy background falhou para ${key}:`, err);
            }
        }

        // 4. APIs (sempre busca para obter rating)
        console.log(`🔍 [API] Buscando: "${key}"`);
        const [r1, r2, r3, r4, r5] = await Promise.allSettled([
            fetchAniList(key),
            fetchKitsu(key),
            fetchMAL(key),
            fetchTMDB(key),
            fetchSimkl(key),
        ]);

        const results = [r1, r2, r3, r4, r5]
            .filter(r => r.status === "fulfilled" && r.value)
            .map(r => r.value);

        // 5. Combina resultados
        const platformVotes = {};
        let bestDubSource = null;
        let bestRating = null;
        let bestRatingSource = null;

        // 🔥 CORREÇÃO: se obtivemos resultado do Crunchyroll, adiciona voto para "crunchyroll"
        if (crunchyResult) {
            platformVotes["crunchyroll"] = (platformVotes["crunchyroll"] || 0) + 0.9;
        }

        const ratingPriority = { anilist: 0, mal: 1, kitsu: 2, tmdb: 3, simkl: 4 };

        for (const r of results) {
            for (const p of (r.platforms || [])) {
                platformVotes[p] = (platformVotes[p] || 0) + (API_WEIGHTS[r.source] || 0.5);
            }
            if (r.hasDubOnCrunchy !== null && r.confidence > (bestDubSource?.confidence || 0)) {
                bestDubSource = r;
            }
            if (r.rating) {
                const priority = ratingPriority[r.source] ?? 99;
                if (!bestRating || priority < (ratingPriority[bestRatingSource] ?? 99)) {
                    bestRating = r.rating;
                    bestRatingSource = r.source;
                }
            }
        }

        const platforms = Object.entries(platformVotes)
            .filter(([, score]) => score >= 0.5)
            .map(([p]) => p);

        // Combina informação de dublagem: se veio do crunchy ou das APIs
        const hasDubOnCrunchy = crunchyResult?.hasDubOnCrunchy || bestDubSource?.hasDubOnCrunchy || false;
        const confidence = bestDubSource?.confidence || 0;
        const hasLanguageInfo = confidence >= 0.9;
        const anilistDub = bestDubSource?.dubElsewhere || {};

        const dubElsewhere = {};
        const allPlatforms = ["netflix", "prime", "disney", "hbo", "apple", "youtube", "paramount", "globoplay", "hidive"];
        for (const p of allPlatforms) {
            if (platforms.includes(p)) {
                if (hasLanguageInfo) {
                    dubElsewhere[p] = anilistDub[p] || false;
                } else {
                    dubElsewhere[p] = null;
                }
            }
        }

        console.log(`✅ ${key}: plataformas=[${platforms.join(",")}] | dubCrunchy=${hasDubOnCrunchy} | conf=${(confidence * 100).toFixed(0)}% | APIs=${results.length}`);

        // Garante que sempre haja um rating (fallback 0.0)
        const final = {
            source: "api",
            hasDubOnCrunchy,
            dubElsewhere,
            platforms,
            confidence,
            rating: bestRating || { score: 0, popularity: 0 },
            learnedAt: Date.now(),
        };

        await saveLearnedEntry(key, final);
        return final;
    })();

    processingCache.set(key, promise);
    try {
        return await promise;
    } finally {
        processingCache.delete(key);
    }
}

// ===================== BADGE =====================
const BADGE_COLORS = {
    "DUB":             { bg: "#00cc66", text: "#000" },
    "LEG":             { bg: "#3399ff", text: "#fff" },
    "DUB NETFLIX":     { bg: "#E50914", text: "#fff" },
    "DUB PRIME":       { bg: "#00A8E1", text: "#fff" },
    "DUB DISNEY":      { bg: "#113CCF", text: "#fff" },
    "DUB HBO":         { bg: "#5522AA", text: "#fff" },
    "DUB APPLE":       { bg: "#555555", text: "#fff" },
    "DUB YOUTUBE":     { bg: "#FF0000", text: "#fff" },
    "DUB PARAMOUNT":   { bg: "#0047AB", text: "#fff" },
    "DUB GLOBOPLAY":   { bg: "#006400", text: "#fff" },
    "DUB HIDIVE":      { bg: "#7B2FBE", text: "#fff" },
    "NETFLIX":         { bg: "#b00710", text: "#fff" },
    "PRIME":           { bg: "#0077a8", text: "#fff" },
    "DISNEY":          { bg: "#0a2880", text: "#fff" },
    "HBO":             { bg: "#3a1570", text: "#fff" },
    "APPLE":           { bg: "#555555", text: "#fff" },
    "YOUTUBE":         { bg: "#CC0000", text: "#fff" },
    "PARAMOUNT":       { bg: "#003366", text: "#fff" },
    "GLOBOPLAY":       { bg: "#004d00", text: "#fff" },
    "HIDIVE":          { bg: "#5B2B8C", text: "#fff" },
};

function buildBadges(anime) {
    const { hasDubOnCrunchy, dubElsewhere = {}, platforms = [], confidence = 0 } = anime;
    const onCrunchy = platforms.includes("crunchyroll");
    const badges = [];

    function altPlatformBadge(key, nameWithDub, nameOnly) {
        if (!platforms.includes(key)) return null;
        const val = dubElsewhere[key];
        if (val === true) {
            return { label: nameWithDub, confidence };
        }
        return { label: nameOnly, confidence: 0.5 };
    }

    if (onCrunchy) {
        badges.push({ label: hasDubOnCrunchy ? "DUB" : "LEG", confidence });
        if (!hasDubOnCrunchy) {
            const n = altPlatformBadge("netflix", "DUB NETFLIX", "NETFLIX");
            const p = altPlatformBadge("prime", "DUB PRIME", "PRIME");
            const d = altPlatformBadge("disney", "DUB DISNEY", "DISNEY");
            const h = altPlatformBadge("hbo", "DUB HBO", "HBO");
            const a = altPlatformBadge("apple", "DUB APPLE", "APPLE");
            const y = altPlatformBadge("youtube", "DUB YOUTUBE", "YOUTUBE");
            const pa = altPlatformBadge("paramount", "DUB PARAMOUNT", "PARAMOUNT");
            const g = altPlatformBadge("globoplay", "DUB GLOBOPLAY", "GLOBOPLAY");
            const hi = altPlatformBadge("hidive", "DUB HIDIVE", "HIDIVE");
            if (n) badges.push(n);
            if (p) badges.push(p);
            if (d) badges.push(d);
            if (h) badges.push(h);
            if (a) badges.push(a);
            if (y) badges.push(y);
            if (pa) badges.push(pa);
            if (g) badges.push(g);
            if (hi) badges.push(hi);
        }
    } else {
        const n = altPlatformBadge("netflix", "DUB NETFLIX", "NETFLIX");
        const p = altPlatformBadge("prime", "DUB PRIME", "PRIME");
        const d = altPlatformBadge("disney", "DUB DISNEY", "DISNEY");
        const h = altPlatformBadge("hbo", "DUB HBO", "HBO");
        const a = altPlatformBadge("apple", "DUB APPLE", "APPLE");
        const y = altPlatformBadge("youtube", "DUB YOUTUBE", "YOUTUBE");
        const pa = altPlatformBadge("paramount", "DUB PARAMOUNT", "PARAMOUNT");
        const g = altPlatformBadge("globoplay", "DUB GLOBOPLAY", "GLOBOPLAY");
        const hi = altPlatformBadge("hidive", "DUB HIDIVE", "HIDIVE");
        if (n) badges.push(n);
        if (p) badges.push(p);
        if (d) badges.push(d);
        if (h) badges.push(h);
        if (a) badges.push(a);
        if (y) badges.push(y);
        if (pa) badges.push(pa);
        if (g) badges.push(g);
        if (hi) badges.push(hi);
    }
    return badges;
}

// ===== RENDER RATING BADGE (SIMPLIFICADO) =====
function renderRatingBadge(card, rating) {
    if (card.querySelector(".ptbr-rating-badge")) return;

    const poster =
        card.querySelector('[class*="poster"]') ||
        card.querySelector("figure") ||
        card;

    if (!poster) return;

    poster.style.position = "relative";

    const score = rating.score;
    const color = getScoreColor(score);

    const el = document.createElement("div");
    el.className = "ptbr-rating-badge";

    el.innerHTML = `⭐ ${score.toFixed(1)}`;

    el.style.cssText = `
        position: absolute;
        top: 6px;
        right: 6px;
        z-index: 999;
        padding: 4px 7px;
        font-size: 11px;
        font-weight: bold;
        border-radius: 8px;
        background: rgba(0,0,0,0.75);
        color: ${color};
        backdrop-filter: blur(4px);
        pointer-events: none;
        text-shadow: 0 0 6px rgba(0,0,0,0.5);
    `;

    poster.appendChild(el);
}

// ===================== REMOVER BADGES NATIVOS =====================
function removeNativeBadges(card) {
    const selectors = [
        '.meta-tags__tag-wrapper',
        '.meta-tags--o80Yw .meta-tags__tag-wrapper',
        '.meta-tags--o8OYw .meta-tags__tag-wrapper',
        '[data-t="badge"]',
        '.badge',
        '.browse-card__badge',
        '.browse-card__badge--dub',
        '.browse-card__badge--sub',
        '.badge--dub',
        '.badge--sub',
        '.browse-card__badge-wrapper .badge',
        '.browse-card__tags .badge',
        '.tag',
        '.label',
        '.browse-card__label',
        '[class*="badge"]:not([class*="maturity"]):not([class*="rating"])',
        '[class*="tag"]:not([class*="maturity"]):not([class*="rating"])'
    ];

    const badgeElements = card.querySelectorAll(selectors.join(','));

    for (const el of badgeElements) {
        if (el.closest('[class*="maturity"]') || el.closest('[class*="rating"]') ||
            el.classList.contains('maturity-rating') || el.classList.contains('maturity--rating')) {
            continue;
        }

        const text = el.textContent.trim();
        if (!text) continue;

        const lower = text.toLowerCase();
        const hasDub = /\bdub\b|dublado/.test(lower);
        const hasLeg = /\bleg\b|legendado/.test(lower);

        if (hasDub || hasLeg) {
            if (el.classList.contains('meta-tags__tag-wrapper') || el.matches('.meta-tags__tag-wrapper--fzf-1')) {
                el.remove();
                console.log(`🗑️ Badge nativo (wrapper) removido: "${text}"`);
            } else {
                el.remove();
                console.log(`🗑️ Badge nativo removido: "${text}"`);
            }
        }
    }

    const allElements = card.querySelectorAll('*');
    for (const el of allElements) {
        if (!el.isConnected) continue;
        if (el.closest('[class*="maturity"]') || el.closest('[class*="rating"]') ||
            el.classList.contains('maturity-rating') || el.classList.contains('maturity--rating')) {
            continue;
        }

        const text = el.textContent.trim();
        if (!text) continue;

        const style = window.getComputedStyle(el);
        const isBadgeLike = 
            (style.display === 'inline-block' || style.display === 'inline' || style.display === 'flex') &&
            parseFloat(style.padding) < 12 &&
            parseFloat(style.fontSize) < 16 &&
            (style.backgroundColor !== 'transparent' || style.borderRadius !== '0px');

        if (!isBadgeLike) continue;

        const lower = text.toLowerCase();
        const hasDub = /\bdub\b|dublado/.test(lower);
        const hasLeg = /\bleg\b|legendado/.test(lower);

        if (hasDub || hasLeg) {
            el.remove();
            console.log(`🗑️ Badge nativo (fallback) removido: "${text}"`);
        }
    }

    const extraSpans = card.querySelectorAll('span[class*="text--gq"]');
    for (const span of extraSpans) {
        if (span.closest('[class*="maturity"]') || span.closest('[class*="rating"]') ||
            span.classList.contains('maturity-rating') || span.classList.contains('maturity--rating')) {
            continue;
        }
        const text = span.textContent.trim();
        if (!text) continue;
        const lower = text.toLowerCase();
        const hasDub = /\bdub\b|dublado/.test(lower);
        const hasLeg = /\bleg\b|legendado/.test(lower);
        if (hasDub || hasLeg) {
            const parent = span.parentElement;
            if (parent && (parent.classList.contains('meta-tags__tag-wrapper') || parent.matches('.meta-tags__tag-wrapper--fzf-1'))) {
                parent.remove();
            } else {
                span.remove();
            }
            console.log(`🗑️ Badge nativo (extra) removido: "${text}"`);
        }
    }
}

function renderBadges(card, badges) {
    if (!badges.length) return;
    removeNativeBadges(card);
    const container = card.querySelector('[data-t="browse-tags"]') ||
                      card.querySelector(".browse-card__footer") ||
                      card;
    if (container.querySelector(".ptbr-badge")) return;

    for (const { label, confidence } of badges) {
        const { bg, text } = BADGE_COLORS[label] || { bg: "#f47521", text: "#000" };
        const opacity = Math.max(0.5, Math.min(1.0, 0.6 + confidence * 0.4));
        const el = document.createElement("span");
        el.className = "ptbr-badge";
        el.title = `Confiança: ${(confidence * 100).toFixed(0)}%`;
        el.textContent = label;
        el.style.cssText = `
            margin-left: 4px;
            padding: 3px 8px;
            font-size: 11px;
            font-weight: bold;
            border-radius: 10px;
            background: ${bg};
            color: ${text};
            display: inline-block;
            white-space: nowrap;
            opacity: ${opacity.toFixed(2)};
            cursor: default;
        `;
        container.appendChild(el);
    }
}

// ===================== PROCESS CARDS =====================
const MAX_PARALLEL = 5;

async function processCard(card) {
    const link = card.querySelector('a[href*="/series/"]');
    if (!link) return;

    const rawTitle = extractTitle(card, link);
    if (!rawTitle) return;

    const seriesUrl = link.href.startsWith("http")
        ? link.href
        : new URL(link.href, location.origin).href;

    console.log(`🎬 Processando: "${rawTitle}"`);

    try {
        const anime = await resolveAnime(rawTitle, seriesUrl);
        if (!anime) return;

        const badges = buildBadges(anime);
        if (badges.length) {
            renderBadges(card, badges);
        }

        if (anime?.rating) {
            renderRatingBadge(card, anime.rating);
        }
    } catch (err) {
        console.warn(`⚠️ Erro ao processar "${rawTitle}"`, err);
    }
}

async function processCards() {
    const cardSelectors = [
        '[data-t="series-card"]',
        '.browse-card--esJdT',
        'article:has(a[href*="/series/"])',
        '.browse-card'
    ];

    const cards = [...document.querySelectorAll(cardSelectors.join(','))]
        .filter(card => !processedCards.has(card));

    if (!cards.length) return;

    console.log(`📦 ${cards.length} novos cards encontrados`);

    for (const card of cards) {
        processedCards.add(card);
    }

    for (let i = 0; i < cards.length; i += MAX_PARALLEL) {
        const batch = cards.slice(i, i + MAX_PARALLEL);
        console.log(`🚀 Lote ${Math.floor(i / MAX_PARALLEL) + 1}: ${batch.length} animes`);
        await Promise.all(batch.map(card => processCard(card)));
    }
}

// ===================== HERO CAROUSEL =====================
const processedHero = new WeakSet();

async function processHeroCard(slide) {
    if (processedHero.has(slide)) return;

    const titleElement =
        slide.querySelector('[class*="seo-title"]') ||
        slide.querySelector('h1') ||
        slide.querySelector('h2') ||
        slide.querySelector('h3');

    if (!titleElement) return;
    const title = titleElement.textContent.trim();
    if (!title) return;

    const bodyContainer =
        titleElement.closest('[class*="hero-card-layout__body"]') ||
        titleElement.closest('[class*="hero-content-card"]') ||
        slide;

    const tagContainer =
        bodyContainer.querySelector('[data-t="meta-tags"]') ||
        bodyContainer.querySelector('[class*="meta-tags"]');

    if (!tagContainer) return;

    removeNativeBadges(bodyContainer);

    const seriesLink = slide.querySelector('a[href*="/series/"]');
    const seriesUrl = seriesLink
        ? new URL(seriesLink.href, location.origin).href
        : null;

    console.log(`🎞️ Hero slide: "${title}"`, seriesUrl || 'sem link');

    try {
        const anime = await resolveAnime(title, seriesUrl);
        if (!anime) return;

        const badges = buildBadges(anime);

        tagContainer.querySelectorAll('.ptbr-hero-badge').forEach(e => e.remove());

        for (const badge of badges) {
            const colors = BADGE_COLORS[badge.label] || { bg: "#f47521", text: "#000" };
            const span = document.createElement("span");
            span.className = "ptbr-badge ptbr-hero-badge";
            span.textContent = badge.label;
            span.style.cssText = `
                margin-left: 6px;
                padding: 4px 8px;
                border-radius: 10px;
                background: ${colors.bg};
                color: ${colors.text};
                font-size: 12px;
                font-weight: bold;
                display: inline-block;
                vertical-align: middle;
            `;
            tagContainer.appendChild(span);
        }

        processedHero.add(slide);

    } catch (err) {
        console.warn(`⚠️ Erro no hero slide "${title}":`, err);
    }
}

async function processAllHeroSlides() {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const slides = document.querySelectorAll('[role="group"][aria-roledescription="Slide"]');
    console.log(`🎞️ ${slides.length} slides do carrossel encontrados`);

    for (const slide of slides) {
        await processHeroCard(slide);
    }
}

function monitorHeroCarousel() {
    const observer = new MutationObserver(() => {
        setTimeout(() => {
            const slides = document.querySelectorAll('[role="group"][aria-roledescription="Slide"]');
            for (const slide of slides) {
                const isActive = [...slide.classList].some(c => c.includes('is-active'));
                if (isActive) {
                    processHeroCard(slide);
                }
            }
        }, 500);
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    setInterval(() => {
        const slides = document.querySelectorAll('[role="group"][aria-roledescription="Slide"]');
        for (const slide of slides) {
            const isActive = [...slide.classList].some(c => c.includes('is-active'));
            if (isActive && !processedHero.has(slide)) {
                processHeroCard(slide);
            }
        }
    }, 3000);
}

// ===================== RUN =====================
async function run() {
    if (running) return;
    running = true;
    try { await processCards(); }
    finally { running = false; }
}

// ===================== START =====================
(async () => {
    await loadDatabase();
    await run();

    await processAllHeroSlides();
    monitorHeroCarousel();

    new MutationObserver(() => setTimeout(run, 500))
        .observe(document.body, { childList: true, subtree: true });

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(async () => {
                await run();
                await processAllHeroSlides();
            }, 800);
        }
    }, 3000);
})();

})();