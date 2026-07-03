// carousel.js (corrigido)

// Guarda { title, badges } por slide — separa "já busquei os dados"
// de "preciso redesenhar o badge", pra poder reaplicar sem refazer fetch.
const heroDataCache = new WeakMap();

// 🔧 Remove badges nativos de áudio (Leg/Dub/Legendado/Dublado/"Leg | Dub")
// Só mexe em elementos-FOLHA (sem filhos de elemento) com texto EXATO,
// pra nunca arriscar apagar maturidade ou gênero junto.
const AUDIO_BADGE_TEXTS = new Set([
    "legendado",
    "dublado",
    "leg",
    "dub",
    "leg | dub",
    "dub | leg"
]);

function removeNativeAudioBadges(scope) {
    const allElements = scope.querySelectorAll('span, div, strong, b, em, p, a');
    for (const el of allElements) {
        if (!el.isConnected) continue;
        if (el.children.length > 0) continue; // só folhas de texto puro

        const text = el.textContent.trim().toLowerCase();
        if (!text) continue;

        if (AUDIO_BADGE_TEXTS.has(text)) {
            const wrapper = el.closest('[class*="tag-wrapper"]') || el;
            wrapper.remove();
            console.log(`🗑️ Badge nativo de áudio removido: "${text}"`);
        }
    }
}

async function processHeroCard(hero) {

    const titleElement =
        hero.querySelector(
            '.hero-content-card__seo-title--Hj9j1'
        );

    if (!titleElement)
        return;

    const title =
        titleElement.textContent.trim();

    if (!title)
        return;

    // Se já buscamos os dados desse título, não refaz o fetch —
    // só garante que o badge ainda está visível (o React pode ter apagado).
    const cached = heroDataCache.get(hero);
    if (cached?.title === title) {
        renderHeroBadges(hero, titleElement, cached.badges);
        return;
    }

    console.log("🎞️ Hero:", title);

    // 🔧 Pega o link da série pra mandar pro resolveAnime.
    // Sem isso, ele não consegue checar o áudio direto na Crunchyroll
    // e depende só de match por nome nas APIs externas (menos confiável).
    const seriesLink = hero.querySelector('a[href*="/series/"]');
    const seriesUrl = seriesLink
        ? new URL(seriesLink.href, location.origin).href
        : null;

    try {

        const anime =
            await resolveAnime(title, seriesUrl); // 🔧 agora passa seriesUrl

        if (!anime)
            return;

        const badges =
            buildBadges(anime);

        heroDataCache.set(hero, { title, badges });

        renderHeroBadges(
            hero,
            titleElement,
            badges
        );

    } catch (e) {

        console.warn(
            "Hero error:",
            title,
            e
        );
    }
}

// 🔧 Checa se os badges já estão exatamente como deveriam, pra evitar
// mexer no DOM à toa (o watchdog chama essa função a cada 1.5s).
function badgesAlreadyApplied(meta, badges) {
    const existing = [...meta.querySelectorAll('.ptbr-hero-badge')]
        .map(e => e.textContent);
    if (existing.length !== badges.length) return false;
    return badges.every((b, i) => existing[i] === b.label);
}

function renderHeroBadges(
    hero,
    titleElement,
    badges
) {

    if (!badges.length)
        return;

    // 🔧 Em vez de pegar o PRIMEIRO [data-t="meta-tags"] do slide inteiro
    // (que pode ser de uma área de promo/cabeçalho), pega o meta-tags que
    // está dentro do MESMO bloco que o título real (hero-card-layout__body).
    const bodyContainer =
        titleElement.closest('[class*="hero-card-layout__body"]') || hero;

    const meta =
        bodyContainer.querySelector(
            '[data-t="meta-tags"]'
        );

    if (!meta)
        return;

    // 🔒 Já está tudo certo? Não mexe em NADA. Evita ficar reescrevendo o
    // DOM a cada chamada do watchdog (o que poderia, em outros cenários
    // com MutationObserver, virar um loop infinito).
    if (badgesAlreadyApplied(meta, badges))
        return;

    // 🔧 Remove o badge nativo "Leg | Dub" / "Legendado" / "Dublado"
    removeNativeAudioBadges(bodyContainer);

    // remove badge anterior nosso (evita duplicar)
    meta.querySelectorAll(
        '.ptbr-hero-badge'
    ).forEach(e => e.remove());

    for (const badge of badges) {

        const colors =
            BADGE_COLORS[
                badge.label
            ] || {
                bg:"#f47521",
                text:"#fff"
            };

        const span =
            document.createElement(
                "span"
            );

        span.className =
            "ptbr-hero-badge";

        span.textContent =
            badge.label;

        span.style.cssText = `
            margin-left:8px;
            padding:4px 10px;
            border-radius:12px;
            background:${colors.bg};
            color:${colors.text};
            font-size:12px;
            font-weight:bold;
            display:inline-block;
            vertical-align:middle;
        `;

        meta.appendChild(span);
    }
}

// 🔧 Watchdog: a Crunchyroll usa React, e React pode re-renderizar o
// carrossel (autoplay, hover, troca de slide) e apagar/reposicionar
// nós que a gente insere manualmente no DOM. Esse intervalo garante
// que o badge do slide ATIVO continua lá — sem refazer o fetch,
// porque processHeroCard já tem o cache do WeakMap.
setInterval(() => {
    const activeHero = document.querySelector(
        '[role="group"][aria-roledescription="Slide"][class*="is-active"]'
    );
    if (!activeHero) return;
    processHeroCard(activeHero);
}, 1500);