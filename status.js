(() => {

console.log("🧠 Anime Status System v8.0 (AniList/Jikan = temporada, TMDB = episódio)");

// ⚠️ COLE SEU TOKEN DO TMDB AQUI (v4 Read Access Token / Bearer)
// NÃO compartilhe esse arquivo publicamente com o token dentro.
const TMDB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIwY2Q3MGI4MTg2N2M2NDI5NjFkOTc3MzBiMTA1YmVlMyIsIm5iZiI6MTc4MjkwNTQ5Ny41NTUsInN1YiI6IjZhNDRmYTk5ZDQ4NWU4ZjY5NTdlMTg3MiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.y8JKG9QhZpkuNBIuZIuzNzJBGJLFoJcSRKyYz0wIZFE";

const CACHE_DURATION = 6 * 60 * 60 * 1000;
const EP_SOON_LIMIT = 3 * 86400000;

// Janela de tempo pra considerar um episódio "recém lançado" e
// mostrar NOVO EP mesmo sem o próximo episódio já ter data marcada.
const RECENT_EP_WINDOW = 5 * 86400000; // 5 dias

const processed = new WeakSet();

const BADGES = {
    NEW_EP: {
        text: "🔵 NOVO EP",
        color: "#1e90ff"
    },
    NEW_EP_SOON: {
        text: "🔵 NOVO EP EM BREVE",
        color: "#4aa3ff"
    },
    NEW_SEASON: {
        text: "🟣 NOVA TEMPORADA",
        color: "#a855f7"
    },
    NEW_SEASON_SOON: {
        text: "🟣 NOVA TEMPORADA EM BREVE",
        color: "#c084fc"
    },
    FINISHED: {
        text: "🔴 FINALIZADO",
        color: "#ef4444"
    }
};

function extractTitle(card, link) {
    return (
        link?.getAttribute("aria-label") ||
        link?.getAttribute("title") ||
        card.querySelector("h3")?.textContent ||
        ""
    ).trim();
}

function normalizeTitle(t) {
    return (t || "")
        .toLowerCase()
        .replace(/\(.*?\)|\[.*?\]/g, "")
        .replace(/dub|sub|dublado|legendado/gi, "")
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// ---------------------------------------------------------
// ANILIST (fonte primária)
// ---------------------------------------------------------

async function fetchAniList(title) {

    const query = `
    query($s:String){
        Media(search:$s,type:ANIME){
            id
            idMal
            title{
                romaji
                english
            }
            status
            format
            season
            seasonYear
            startDate{
                year
                month
                day
            }
            nextAiringEpisode{
                airingAt
                episode
            }
            relations{
                edges{
                    relationType
                    node{
                        id
                        idMal
                        title{
                            romaji
                            english
                        }
                        status
                        format
                        season
                        seasonYear
                        startDate{
                            year
                            month
                            day
                        }
                        nextAiringEpisode{
                            airingAt
                            episode
                        }
                    }
                }
            }
        }
    }`;

    try {

        const res = await fetch(
            "https://graphql.anilist.co",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    query,
                    variables: {
                        s: title
                    }
                })
            }
        );

        const data = await res.json();

        return data?.data?.Media || null;

    } catch(e) {
        return null;
    }
}

function getTVSeasons(media) {

    const seasons = [];

    if (
        media &&
        media.format === "TV"
    ) {
        seasons.push(media);
    }

    for (const rel of media?.relations?.edges || []) {

        if (
            rel.relationType !== "SEQUEL" &&
            rel.relationType !== "PREQUEL"
        ) continue;

        const anime = rel.node;

        if (
            anime &&
            anime.format === "TV"
        ) {
            seasons.push(anime);
        }
    }

    return seasons.filter(Boolean);
}

function getDateValue(a) {

    const y = a?.startDate?.year || 0;
    const m = a?.startDate?.month || 0;
    const d = a?.startDate?.day || 0;

    return new Date(y, m - 1, d).getTime();
}

function pickLatestSeason(seasons) {

    if (!seasons.length)
        return null;

    return [...seasons].sort((a,b) => {

        const aDate = getDateValue(a);
        const bDate = getDateValue(b);

        if (aDate !== bDate)
            return bDate - aDate;

        return (b.seasonYear || 0)
            - (a.seasonYear || 0);

    });
}

// A AniList é a autoridade em "vai ter temporada nova?" — ela tem as
// relações SEQUEL/PREQUEL e sabe de temporadas anunciadas antes de
// qualquer episódio existir. O TMDB não enxerga isso direito.
//
// Aqui só detectamos NEW_SEASON / NEW_SEASON_SOON. Detecção de
// episódio (NEW_EP / NEW_EP_SOON) fica por conta do TMDB, que tem
// a data real do próximo episódio.
//
// Retorna { statusList, season } — o "season" é devolvido pra
// permitir validar o sinal com o Jikan via idMal, sem precisar
// buscar por texto de novo.
function resolveSeasonStatusAniList(seasons) {

    if (!seasons || !seasons.length)
        return { statusList: [], season: null };

    const now = Date.now();

    // seasons já vem ordenado da mais avançada (maior data) pra mais antiga
    const mostAdvanced = seasons[0];

    // Ep1 dessa temporada ainda não confirmado como já exibido =
    // temporada nova, seja ela "em breve" ou recém lançada.
    // Isso vale independente do campo "status" vir certo ou não na
    // AniList (é comum ver "Airing Ep 1: 6d 18h..." com status
    // ainda como RELEASING por atraso de atualização).
    if (mostAdvanced.nextAiringEpisode?.episode === 1) {

        const diff =
            mostAdvanced.nextAiringEpisode.airingAt * 1000
            - now;

        return {
            statusList: diff > 0
                ? ["NEW_SEASON_SOON"]
                : ["NEW_SEASON"],
            season: mostAdvanced
        };
    }

    // Anunciada (ex: Start Date "Jan 2027") mas ainda sem Ep1 marcado
    if (mostAdvanced.status === "NOT_YET_RELEASED") {
        return {
            statusList: ["NEW_SEASON_SOON"],
            season: mostAdvanced
        };
    }

    // Nenhum sinal de temporada nova pendente — quem decide
    // episódio/finalizado a partir daqui é o TMDB
    return { statusList: [], season: null };
}

// Só usado quando o TMDB não responde nada: fallback genérico
// baseado só no que a AniList sabe. Repara que NÃO decidimos
// FINISHED aqui — isso é trabalho exclusivo do TMDB.
function resolveGenericAniList(seasons) {

    if (!seasons || !seasons.length)
        return [];

    const hasReleasing =
        seasons.some(s => s.status === "RELEASING");

    if (hasReleasing)
        return ["NEW_EP_SOON"];

    return [];
}

// ---------------------------------------------------------
// JIKAN / MyAnimeList (fallback de temporada quando a AniList
// bugar ou não retornar nenhum sinal)
// ---------------------------------------------------------

// O Jikan tem rate limit apertado (uns 3 req/seg, 60/min). Como só
// chamamos ele quando a AniList falhou/não deu sinal (não em todo
// card), o volume é baixo — mas mesmo assim espaçamos as chamadas
// numa fila simples pra nunca estourar o limite quando vários
// cards são processados juntos (ex: scroll rápido).
let jikanQueue = Promise.resolve();

function queueJikanCall(fn) {

    const result = jikanQueue.then(
        () => new Promise(r => setTimeout(r, 400))
    ).then(fn);

    // encadeia mesmo se der erro, pra fila não travar
    jikanQueue = result.catch(() => {});

    return result;
}

// Busca pelo ID do MAL — usado quando já temos o id (ex: seguindo
// uma relação "Sequel" dentro do próprio Jikan)
async function fetchJikanById(malId) {

    if (!malId)
        return null;

    return queueJikanCall(async () => {

        try {

            const res = await fetch(
                `https://api.jikan.moe/v4/anime/${malId}`
            );

            if (!res.ok)
                return null;

            const data = await res.json();

            return data?.data || null;

        } catch(e) {
            return null;
        }
    });
}

// Busca por texto — só usada quando a AniList não deu nenhum id
// pra seguir (ela bugou, deu timeout, ou não achou o anime).
async function fetchJikanByTitle(title) {

    return queueJikanCall(async () => {

        try {

            const res = await fetch(
                `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&type=tv&limit=1`
            );

            if (!res.ok)
                return null;

            const data = await res.json();

            return data?.data?.[0] || null;

        } catch(e) {
            return null;
        }
    });
}

function jikanSeasonStatusFromEntry(entry) {

    if (!entry)
        return [];

    const now = Date.now();

    if (entry.status === "Not yet aired") {

        const airFrom =
            entry.aired?.from
                ? new Date(entry.aired.from).getTime()
                : null;

        if (!airFrom)
            return ["NEW_SEASON_SOON"];

        return airFrom - now > 0
            ? ["NEW_SEASON_SOON"]
            : ["NEW_SEASON"];
    }

    return [];
}

// Fallback completo: só é chamado quando a AniList não retornou
// nada útil. Busca o anime por título no Jikan; se ele já estiver
// "Not yet aired", pronto. Senão, segue a relação "Sequel" (por ID,
// dentro do próprio Jikan) pra ver se existe uma temporada seguinte
// anunciada.
async function resolveSeasonStatusJikanFallback(title) {

    const base = await fetchJikanByTitle(title);

    if (!base)
        return { statusList: [], season: null };

    const baseStatus =
        jikanSeasonStatusFromEntry(base);

    if (baseStatus.length) {
        return { statusList: baseStatus, season: base };
    }

    const sequelRel = (base.relations || []).find(
        r => r.relation === "Sequel"
    );

    const sequelId =
        sequelRel?.entry?.[0]?.mal_id;

    if (!sequelId)
        return { statusList: [], season: null };

    const sequel = await fetchJikanById(sequelId);

    const sequelStatus =
        jikanSeasonStatusFromEntry(sequel);

    if (sequelStatus.length) {
        return { statusList: sequelStatus, season: sequel };
    }

    return { statusList: [], season: null };
}

// ---------------------------------------------------------
// TMDB (fallback / validação secundária)
// ---------------------------------------------------------

async function fetchTMDB(title) {

    if (
        !TMDB_TOKEN ||
        TMDB_TOKEN === "COLE_SEU_TOKEN_AQUI"
    ) {
        return null;
    }

    try {

        const searchRes = await fetch(
            `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(title)}`,
            {
                headers: {
                    "Authorization": `Bearer ${TMDB_TOKEN}`,
                    "Content-Type": "application/json;charset=utf-8"
                }
            }
        );

        const searchData = await searchRes.json();

        const match = searchData?.results?.[0];

        if (!match)
            return null;

        const detailsRes = await fetch(
            `https://api.themoviedb.org/3/tv/${match.id}`,
            {
                headers: {
                    "Authorization": `Bearer ${TMDB_TOKEN}`,
                    "Content-Type": "application/json;charset=utf-8"
                }
            }
        );

        return await detailsRes.json();

    } catch(e) {
        return null;
    }
}

// Verifica se a temporada ATUAL do show já exibiu todos os episódios
// dela — comparando o último episódio exibido (last_episode_to_air)
// com o total de episódios cadastrados pra aquela temporada
// (seasons[].episode_count). Isso é mais confiável que o campo
// "status" geral do show, que fica "Returning Series" até a próxima
// temporada ser oficialmente confirmada, mesmo com a atual já
// totalmente encerrada.
function isSeasonFullyAired(details) {

    const last = details?.last_episode_to_air;

    if (!last)
        return false;

    const seasonInfo = (details.seasons || []).find(
        s => s.season_number === last.season_number
    );

    if (!seasonInfo || !seasonInfo.episode_count)
        return false;

    return last.episode_number >= seasonInfo.episode_count;
}

// O TMDB é a autoridade em episódio: tanto o último que já saiu
// (last_episode_to_air) quanto o próximo agendado (next_episode_to_air).
//
// Ordem de checagem:
// 1) Um episódio saiu há pouco tempo (dentro da janela "recente")
//    -> NOVO EP, mesmo que o próximo ainda não tenha data marcada.
// 2) Tem um próximo episódio com data marcada -> EM BREVE (se a
//    data ainda não chegou) ou NOVO EP (se já passou).
// 3) Sem nenhum dos dois, mas o show está oficialmente em produção
//    -> EM BREVE, como sinal fraco.
//
// Importante: essa função NUNCA decide "nova temporada" — se chegar
// aqui é porque a AniList (ou o fallback do Jikan) já teve a chance
// de marcar como nova temporada e não marcou.
function resolveEpisodeStatusTMDB(details) {

    if (!details)
        return [];

    const now = Date.now();

    // Se a temporada atual já exibiu tudo, isso não é "novo ep" —
    // vira decisão do resolveFinishedStatus, não daqui.
    if (isSeasonFullyAired(details)) {
        return [];
    }

    const last = details.last_episode_to_air;

    if (last?.air_date) {

        const lastAirTime =
            new Date(last.air_date + "T00:00:00").getTime();

        const sinceLast = now - lastAirTime;

        if (
            sinceLast >= 0 &&
            sinceLast <= RECENT_EP_WINDOW
        ) {
            return ["NEW_EP"];
        }
    }

    const next = details.next_episode_to_air;

    if (next?.air_date) {

        const airTime =
            new Date(next.air_date + "T00:00:00").getTime();

        const diff = airTime - now;

        return diff > 0
            ? ["NEW_EP_SOON"]
            : ["NEW_EP"];
    }

    if (details.status === "In Production") {
        return ["NEW_EP_SOON"];
    }

    return [];
}

// Finalizado é decisão exclusiva do TMDB — a AniList só enxerga
// bem "vai ter episódio/temporada nova", o campo status dela pra
// FINISHED costuma ficar defasado ou incompleto em franquias
// grandes. Quem confirma que realmente acabou é o TMDB.
//
// Duas formas de confirmar:
// 1) status geral do show é Ended/Canceled, OU
// 2) a temporada atual já exibiu TODOS os episódios dela e não tem
//    próximo episódio agendado — mesmo que o show ainda apareça
//    como "Returning Series" esperando confirmação da próxima
//    temporada (é exatamente esse caso que estava saindo como
//    "novo ep em breve" por engano).
function resolveFinishedStatus(tmdbDetails) {

    if (!tmdbDetails)
        return false;

    if (
        tmdbDetails.status === "Ended" ||
        tmdbDetails.status === "Canceled"
    ) {
        return true;
    }

    if (
        !tmdbDetails.next_episode_to_air &&
        isSeasonFullyAired(tmdbDetails)
    ) {
        return true;
    }

    return false;
}

// ---------------------------------------------------------
// Render + cache + orquestração
// ---------------------------------------------------------

function renderBadge(card, badge) {

    const poster =
        card.querySelector('[class*="poster"]') ||
        card.querySelector("figure") ||
        card;

    if (!poster)
        return;

    if (
        poster.querySelector(
            `[data-badge="${badge.text}"]`
        )
    ) return;

    poster.style.position = "relative";

    const el =
        document.createElement("div");

    el.setAttribute(
        "data-badge",
        badge.text
    );

    el.textContent =
        badge.text;

    el.style.cssText = `
        position:absolute;
        top:6px;
        left:6px;
        z-index:999;
        padding:4px 8px;
        font-size:11px;
        font-weight:bold;
        border-radius:8px;
        background:${badge.color};
        color:white;
        pointer-events:none;
        white-space:nowrap;
        font-family:inherit;
    `;

    poster.appendChild(el);
}

async function resolveStatusList(title) {

    // Busca AniList e TMDB SEMPRE em paralelo — a AniList nunca deve
    // impedir o TMDB de rodar, mesmo se ela bugar, travar ou não
    // achar nada. Cada uma resolve rápido e independente da outra.
    const [media, tmdbDetails] = await Promise.all([
        fetchAniList(title),
        fetchTMDB(title)
    ]);

    let seasons = null;

    if (media) {
        seasons = pickLatestSeason(getTVSeasons(media));
    }

    // PRIORIDADE 1 — ANILIST: existe temporada nova pendente/recém lançada?
    let { statusList: seasonStatus, season: seasonUsed } =
        resolveSeasonStatusAniList(seasons);

    let seasonSource = "anilist";

    // A AniList não retornou nada útil (bugou, deu timeout, ou
    // simplesmente não achou nenhum sinal de temporada) — cai pro
    // Jikan como fallback pra verificar temporada nova.
    if (!seasonStatus.length) {

        const jikanFallback =
            await resolveSeasonStatusJikanFallback(title);

        if (jikanFallback.statusList.length) {
            seasonStatus = jikanFallback.statusList;
            seasonUsed = jikanFallback.season;
            seasonSource = "jikan";
        }
    }

    if (seasonStatus.length) {
        return { source: seasonSource, statusList: seasonStatus };
    }

    // PRIORIDADE 2 — TMDB: sem temporada nova pendente em nenhuma
    // das duas fontes, verifica episódio (recente ou próximo)
    const episodeStatus =
        resolveEpisodeStatusTMDB(tmdbDetails);

    if (episodeStatus.length) {
        return { source: "tmdb", statusList: episodeStatus };
    }

    // PRIORIDADE 3 — FINALIZADO: decisão exclusiva do TMDB
    if (resolveFinishedStatus(tmdbDetails)) {
        return { source: "tmdb", statusList: ["FINISHED"] };
    }

    // PRIORIDADE 4 — fallback residual só com o que a AniList sabe,
    // pra quando o TMDB não tem token configurado ou não achou nada
    const genericStatus =
        resolveGenericAniList(seasons);

    if (genericStatus.length) {
        return { source: "anilist", statusList: genericStatus };
    }

    return { source: null, statusList: [] };
}

async function processCard(card) {

    if (processed.has(card))
        return;

    processed.add(card);

    const link =
        card.querySelector(
            'a[href*="/series/"]'
        );

    if (!link)
        return;

    const title =
        normalizeTitle(
            extractTitle(card, link)
        );

    if (!title)
        return;

    const cacheKey =
        "status_" + title;

    try {

        const cached =
            (
                await chrome.storage.local.get(
                    cacheKey
                )
            )[cacheKey];

        if (
            cached &&
            Date.now() - cached.time
                < CACHE_DURATION
        ) {

            cached.status.forEach(
                s => renderBadge(
                    card,
                    BADGES[s]
                )
            );

            return;
        }

    } catch {}

    const { source, statusList } =
        await resolveStatusList(title);

    if (!statusList.length)
        return;

    try {

        await chrome.storage.local.set({
            [cacheKey]: {
                time: Date.now(),
                status: statusList,
                source
            }
        });

    } catch {}

    statusList.forEach(
        s => renderBadge(
            card,
            BADGES[s]
        )
    );
}

function scan() {

    document
        .querySelectorAll(
            '[data-t="series-card"], .browse-card--esJdT, .browse-card'
        )
        .forEach(processCard);
}

const observer =
    new MutationObserver(() => {

        setTimeout(
            scan,
            500
        );

    });

observer.observe(
    document.body,
    {
        childList: true,
        subtree: true
    }
);

setTimeout(
    scan,
    1500
);

console.log(
    "🚀 Status System v8.0 iniciado"
);

})();