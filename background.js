// background.js
// Pool de workers com UMA janela + abas reutilizáveis
// Fecha janela automaticamente por inatividade (30s) ou se não houver páginas da Crunchyroll abertas
// Ao recarregar a página, reutiliza a janela existente em vez de criar uma nova

const MAX_WORKERS = 5;
const IDLE_TIMEOUT = 30000; // 30 segundos sem uso

let workerWindow = null;
let workers = [];
let queue = [];
let initialized = false;
let initPromise = null;      // lock para evitar dupla inicialização
let processing = false;      // trava para processQueue
let lastUsage = Date.now();
let cleanupTimer = null;

// =============================================
// 1. VERIFICA SE A JANELA AINDA EXISTE
// =============================================
async function isWindowAlive(windowId) {
    if (!windowId) return false;
    try {
        const win = await chrome.windows.get(windowId);
        return !!win;
    } catch {
        return false;
    }
}

// =============================================
// 2. INICIALIZAÇÃO COM LOCK + VERIFICAÇÃO DE JANELA EXISTENTE
// =============================================
async function initializeWorkers() {
    // Se já está inicializado, verifica se a janela ainda existe
    if (initialized) {
        const alive = await isWindowAlive(workerWindow?.id);
        if (alive) {
            return; // janela existe, reutiliza
        } else {
            // Janela foi fechada, reseta estado
            console.log("🔄 Janela de workers foi fechada. Resetando...");
            initialized = false;
            workerWindow = null;
            workers = [];
            initPromise = null;
            // Não fecha o timer, ele será reiniciado se necessário
        }
    }

    // Se já há uma inicialização em andamento, aguarda
    if (initPromise) return initPromise;

    initPromise = (async () => {
        console.log("🚀 Inicializando workers...");

        try {
            // Cria UMA janela popup minimizada
            workerWindow = await chrome.windows.create({
                url: "about:blank",
                type: "popup",
                focused: false,
                state: "minimized"
            });

            workers = [];

            for (let i = 0; i < MAX_WORKERS; i++) {
                const tab = await chrome.tabs.create({
                    windowId: workerWindow.id,
                    url: "about:blank",
                    active: false
                });

                workers.push({
                    tabId: tab.id,
                    busy: false
                });
            }

            initialized = true;
            console.log(`✅ ${workers.length} workers criados na janela ${workerWindow.id}`);

        } catch (error) {
            console.error("❌ Falha ao inicializar workers:", error);
            initPromise = null;
            throw error;
        }
    })();

    return initPromise;
}

// =============================================
// 3. VERIFICA SE HÁ PÁGINAS DA CRUNCHYROLL ABERTAS
// =============================================
async function hasCrunchyTabs() {
    try {
        const tabs = await chrome.tabs.query({ url: "https://www.crunchyroll.com/*" });
        return tabs.length > 0;
    } catch {
        return false;
    }
}

// =============================================
// 4. WATCHDOG DE INATIVIDADE + FECHAMENTO INTELIGENTE
// =============================================
async function closeWorkers() {
    console.log("🧹 Fechando workers por inatividade...");

    try {
        if (workerWindow) {
            await chrome.windows.remove(workerWindow.id);
        }
    } catch (e) {
        // janela já pode ter sido fechada
    }

    workers = [];
    workerWindow = null;
    initialized = false;
    initPromise = null;
    queue = [];
    processing = false;

    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }

    console.log("✅ Workers liberados.");
}

function startCleanupWatcher() {
    if (cleanupTimer) return;

    cleanupTimer = setInterval(async () => {
        const idleTime = Date.now() - lastUsage;

        // Fecha se ficou inativo por mais de IDLE_TIMEOUT
        if (idleTime > IDLE_TIMEOUT && initialized) {
            await closeWorkers();
            return;
        }

        // Fecha se não houver mais nenhuma aba da Crunchyroll aberta no navegador
        if (initialized) {
            const hasTabs = await hasCrunchyTabs();
            if (!hasTabs) {
                console.log("🧹 Nenhuma aba da Crunchyroll aberta. Fechando workers...");
                await closeWorkers();
            }
        }

        // Verifica se a janela ainda existe (pode ter sido fechada manualmente)
        if (initialized && workerWindow) {
            const alive = await isWindowAlive(workerWindow.id);
            if (!alive) {
                console.log("🔄 Janela de workers foi fechada manualmente. Resetando estado...");
                initialized = false;
                workerWindow = null;
                workers = [];
                initPromise = null;
                // O timer continuará rodando, mas na próxima iteração não haverá janela
            }
        }
    }, 5000); // verifica a cada 5 segundos
}

// =============================================
// 5. PROCESSAMENTO DE FILA (com trava)
// =============================================
async function processQueue() {
    if (processing) return;
    processing = true;

    try {
        for (const worker of workers) {
            if (worker.busy) continue;

            const job = queue.shift();
            if (!job) break;

            worker.busy = true;

            processAnime(worker, job.url)
                .then(result => {
                    job.resolve(result);
                })
                .catch(error => {
                    job.resolve({ found: false, error: error.message });
                })
                .finally(() => {
                    worker.busy = false;
                    processQueue();
                });
        }
    } finally {
        processing = false;
    }
}

// =============================================
// 6. EXTRAI ÁUDIO (usando a aba worker)
// =============================================
async function waitForAudio(tabId, timeout = 10000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    return !!document.querySelector(
                        '[data-t="detail-row-audio-language"]'
                    );
                }
            });

            if (result?.result) return true;
        } catch {}

        await new Promise(r => setTimeout(r, 200));
    }

    return false;
}

async function processAnime(worker, url) {
    try {
        // Navega para a URL do anime
        await chrome.tabs.update(worker.tabId, { url });

        // Aguarda carregamento completo
        await new Promise(resolve => {
            const listener = (id, info) => {
                if (id === worker.tabId && info.status === "complete") {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });

        // Aguarda React renderizar o elemento de áudio
        const found = await waitForAudio(worker.tabId);
        if (!found) {
            await chrome.tabs.update(worker.tabId, { url: "about:blank" });
            return { found: false, text: null, html: null };
        }

        // Captura o texto do elemento
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: worker.tabId },
            func: () => {
                const row = document.querySelector(
                    '[data-t="detail-row-audio-language"]'
                );
                if (!row) return { found: false, text: null, html: null };
                return {
                    found: true,
                    text: row.innerText,
                    html: row.outerHTML
                };
            }
        });

        // Libera a aba
        await chrome.tabs.update(worker.tabId, { url: "about:blank" });

        return result.result || { found: false, text: null, html: null };

    } catch (err) {
        // Tenta restaurar a aba
        try {
            await chrome.tabs.update(worker.tabId, { url: "about:blank" });
        } catch {}
        return { found: false, text: null, html: null, error: err.message };
    }
}

// =============================================
// 7. ENQUEUE – PONTO DE ENTRADA
// =============================================
async function enqueue(url) {
    await initializeWorkers();

    // Atualiza timestamp de uso e inicia watcher
    lastUsage = Date.now();
    startCleanupWatcher();

    return new Promise(resolve => {
        queue.push({ url, resolve });
        processQueue();
    });
}

// =============================================
// 8. LISTENER DO CONTENT SCRIPT
// =============================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action !== "getCrunchyAudio") return;

    enqueue(msg.url)
        .then(result => {
            console.log("RESULTADO:", result);
            sendResponse({ success: true, audio: result });
        })
        .catch(error => {
            sendResponse({ success: false, error: error.message });
        });

    return true; // canal aberto para resposta assíncrona
});

// =============================================
// 9. LIMPEZA NA SUSPENSÃO DA EXTENSÃO
// =============================================
chrome.runtime.onSuspend.addListener(async () => {
    console.log("⏳ Extensão sendo suspensa, fechando workers...");
    try {
        if (workerWindow) {
            await chrome.windows.remove(workerWindow.id);
        }
    } catch {}
});