import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function isPlaylistUrl(url) {
    if (!url) return false;
    const lower = String(url).toLowerCase();
    return lower.includes(".m3u8") || lower.includes(".m3u");
}

function cleanAndDedupe(urls) {
    const normalize = (u) =>
        String(u)
            .trim()
            .replace(/&amp;/g, "&")
            .replace(/\\u0026/g, "&")
            .replace(/\\\//g, "/");

    return Array.from(new Set(urls.filter(Boolean).map(normalize).filter(isPlaylistUrl)));
}

function extractPlaylistLinksFromText(text) {
    if (!text) return [];
    const re = /https?:\/\/[^\s"'<>]+\.m3u8?[^\s"'<>]*/gi;
    return text.match(re) || [];
}

app.get("/health", (_, res) => res.json({ ok: true }));

async function runWithBrowser(fn) {
    const browser = await chromium.launch({ headless: true });

    try {
        const context = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
            viewport: { width: 1366, height: 768 },
            javaScriptEnabled: true,
            ignoreHTTPSErrors: true,
        });

        const page = await context.newPage();
        return await fn({ page, context });
    } finally {
        await browser.close().catch(() => { });
    }
}

function attachPlaylistCapture(page, found, debug = []) {
    const capture = (url, source = "network") => {
        if (isPlaylistUrl(url)) {
            found.add(url);
            debug.push({ source, url });
            console.log("FOUND PLAYLIST:", source, url);
        }
    };

    page.on("request", (req) => {
        capture(req.url(), `request:${req.resourceType()}`);
    });

    page.on("response", async (resp) => {
        capture(resp.url(), `response:${resp.request().resourceType()}`);

        try {
            const ct = (resp.headers()["content-type"] || "").toLowerCase();

            const isReadable =
                ct.includes("application/json") ||
                ct.includes("text/") ||
                ct.includes("javascript") ||
                ct.includes("mpegurl") ||
                ct.includes("application/vnd.apple.mpegurl") ||
                ct.includes("application/x-mpegurl");

            if (!isReadable) return;

            const size = Number(resp.headers()["content-length"] || 0);
            if (size && size > 5_000_000) return;

            const body = await resp.text().catch(() => "");
            extractPlaylistLinksFromText(body).forEach((link) => capture(link, "response-body"));
        } catch { }
    });
}

async function scanHtmlAndScripts(page, found, debug) {
    const capture = (url, source) => {
        if (isPlaylistUrl(url)) {
            found.add(url);
            debug.push({ source, url });
            console.log("FOUND PLAYLIST:", source, url);
        }
    };

    const html = await page.content().catch(() => "");
    extractPlaylistLinksFromText(html).forEach((link) => capture(link, "html"));

    const scripts = await page
        .locator("script")
        .evaluateAll((nodes) => nodes.map((n) => n.textContent || "").join("\n"))
        .catch(() => "");

    extractPlaylistLinksFromText(scripts).forEach((link) => capture(link, "script"));
}

async function clickPossiblePlayers(page) {
    const selectors = [
        "video",
        "button",
        ".vjs-big-play-button",
        ".jw-icon-playback",
        ".jwplayer",
        ".plyr__control",
        ".play",
        "[class*='play']",
        "[id*='play']",
        "iframe",
    ];

    await page.mouse.click(680, 380).catch(() => { });
    await page.keyboard.press("Space").catch(() => { });

    for (const selector of selectors) {
        const count = await page.locator(selector).count().catch(() => 0);

        for (let i = 0; i < Math.min(count, 5); i++) {
            await page.locator(selector).nth(i).click({ force: true, timeout: 1500 }).catch(() => { });
            await page.waitForTimeout(700);
        }
    }

    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;

        try {
            await frame.locator("video").first().click({ force: true, timeout: 1500 }).catch(() => { });
            await frame.locator("button").first().click({ force: true, timeout: 1500 }).catch(() => { });
            await frame.locator(".vjs-big-play-button").first().click({ force: true, timeout: 1500 }).catch(() => { });
            await frame.locator(".jw-icon-playback").first().click({ force: true, timeout: 1500 }).catch(() => { });
            await frame.locator("[class*='play']").first().click({ force: true, timeout: 1500 }).catch(() => { });
            await page.waitForTimeout(1000);
        } catch { }
    }
}

async function waitForPlaylists(page, found, timeoutMs = 20000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        if (found.size > 0) return true;
        await page.waitForTimeout(500);
    }

    return false;
}

app.post("/scrape-direct", async (req, res) => {
    const { url, waitMs } = req.body;
    if (!url) return res.status(400).json({ error: "Missing url" });

    try {
        const result = await runWithBrowser(async ({ page }) => {
            const found = new Set();
            const debug = [];

            attachPlaylistCapture(page, found, debug);

            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
            await page.waitForTimeout(3000);

            console.log("Final URL:", page.url());
            console.log("Title:", await page.title().catch(() => "No title"));
            console.log("Frames:", page.frames().map((f) => f.url()));

            await scanHtmlAndScripts(page, found, debug);
            await clickPossiblePlayers(page);
            await waitForPlaylists(page, found, Number(waitMs) || 25000);

            if (found.size === 0) {
                await page.waitForTimeout(3000);
                await scanHtmlAndScripts(page, found, debug);
                await clickPossiblePlayers(page);
                await waitForPlaylists(page, found, 15000);
            }

            await page.screenshot({ path: "debug-direct.png", fullPage: true }).catch(() => { });

            return {
                results: cleanAndDedupe(Array.from(found)),
                debug: debug.slice(-100),
                frames: page.frames().map((f) => f.url()),
                finalUrl: page.url(),
                title: await page.title().catch(() => ""),
            };
        });

        return res.json({
            source: url,
            totalStreams: result.results.length,
            results: result.results,
            debug: result.debug,
            frames: result.frames,
            finalUrl: result.finalUrl,
            title: result.title,
        });
    } catch (err) {
        return res.status(500).json({
            error: "Direct scrape failed",
            details: String(err?.message || err),
        });
    }
});

app.post("/scrape-menu", async (req, res) => {
    const { url, menuSelector, subSelector, limit, waitMs } = req.body;

    if (!url) return res.status(400).json({ error: "Missing url" });

    const MENU_SEL = menuSelector || "ul.menu";
    const SUB_SEL = subSelector || "ul.menu li.subitem1 a";
    const LIMIT = limit ? Number(limit) : null;

    try {
        const result = await runWithBrowser(async ({ page }) => {
            const found = new Set();
            const debug = [];
            const visited = new Set();

            attachPlaylistCapture(page, found, debug);

            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
            await page.waitForTimeout(2000);
            await page.waitForSelector(MENU_SEL, { timeout: 25000 });

            const subHrefs = await page.$$eval(SUB_SEL, (as) =>
                as
                    .map((a) => a.getAttribute("href"))
                    .filter(Boolean)
                    .map((h) => h.trim())
            );

            const absoluteHrefs = Array.from(
                new Set(
                    subHrefs.map((h) => {
                        try {
                            return new URL(h, window.location.href).toString();
                        } catch {
                            return h;
                        }
                    })
                )
            );

            const targets = LIMIT ? absoluteHrefs.slice(0, LIMIT) : absoluteHrefs;

            for (const href of targets) {
                if (visited.has(href)) continue;
                visited.add(href);

                const before = found.size;

                await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60000 });
                await page.waitForTimeout(3000);

                await scanHtmlAndScripts(page, found, debug);
                await clickPossiblePlayers(page);
                await waitForPlaylists(page, found, Number(waitMs) || 15000);

                if (found.size === before) {
                    await clickPossiblePlayers(page);
                    await waitForPlaylists(page, found, 8000);
                }
            }

            return {
                subLinksFound: absoluteHrefs.length,
                scanned: targets.length,
                results: cleanAndDedupe(Array.from(found)),
                debug: debug.slice(-100),
            };
        });

        return res.json({
            source: url,
            menuSelector: MENU_SEL,
            subSelector: SUB_SEL,
            subLinksFound: result.subLinksFound,
            scanned: result.scanned,
            totalStreams: result.results.length,
            results: result.results,
            debug: result.debug,
        });
    } catch (err) {
        return res.status(500).json({
            error: "Menu scrape failed",
            details: String(err?.message || err),
        });
    }
});

const PORT = process.env.PORT || 5179;
app.listen(PORT, () => console.log(`Scraper API running at http://localhost:${PORT}`));