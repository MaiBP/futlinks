import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

function isOriginAllowed(origin) {
    if (!origin) return true;
    if (allowedOrigins.length === 0) return true;
    return allowedOrigins.includes(origin);
}

app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (isOriginAllowed(origin)) {
        res.header("Access-Control-Allow-Origin", origin || "*");
    }

    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.header("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") return res.sendStatus(204);

    return next();
});

app.use(cors({
    origin(origin, callback) {
        if (isOriginAllowed(origin)) return callback(null, true);
        return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
}));
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

function getProxyUrl(req, targetUrl) {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    return `${baseUrl}/hls-proxy?url=${encodeURIComponent(targetUrl)}`;
}

function getProxyHeaders(targetUrl) {
    const url = new URL(targetUrl);

    return {
        "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "accept": "*/*",
        "origin": url.origin,
        "referer": `${url.origin}/`,
    };
}

function rewritePlaylist(content, baseUrl, req) {
    return content
        .split("\n")
        .map((line) => {
            const trimmed = line.trim();

            if (!trimmed) return line;

            if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-MAP")) {
                return line.replace(/URI="([^"]+)"/g, (_, uri) => {
                    const absoluteUrl = new URL(uri, baseUrl).toString();
                    return `URI="${getProxyUrl(req, absoluteUrl)}"`;
                });
            }

            if (trimmed.startsWith("#")) return line;

            const absoluteUrl = new URL(trimmed, baseUrl).toString();
            return getProxyUrl(req, absoluteUrl);
        })
        .join("\n");
}

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/hls-proxy", async (req, res) => {
    const target = req.query.url;

    if (!target || typeof target !== "string") {
        return res.status(400).json({ error: "Missing url" });
    }

    let targetUrl;

    try {
        targetUrl = new URL(target);
    } catch {
        return res.status(400).json({ error: "Invalid url" });
    }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
        return res.status(400).json({ error: "Unsupported protocol" });
    }

    try {
        const upstream = await fetch(targetUrl.toString(), {
            headers: getProxyHeaders(targetUrl.toString()),
            redirect: "follow",
        });

        res.status(upstream.status);

        const contentType = upstream.headers.get("content-type") || "";
        const isPlaylist =
            contentType.toLowerCase().includes("mpegurl") ||
            targetUrl.pathname.toLowerCase().includes(".m3u");

        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Access-Control-Allow-Origin", "*");

        if (!upstream.ok) {
            const body = await upstream.text().catch(() => "");
            return res.send(body || upstream.statusText);
        }

        if (isPlaylist) {
            const playlist = await upstream.text();
            res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            return res.send(rewritePlaylist(playlist, targetUrl.toString(), req));
        }

        const body = Buffer.from(await upstream.arrayBuffer());
        res.setHeader("Content-Type", contentType || "application/octet-stream");

        const contentLength = upstream.headers.get("content-length");
        if (contentLength) res.setHeader("Content-Length", contentLength);

        return res.send(body);
    } catch (err) {
        return res.status(502).json({
            error: "Proxy request failed",
            details: String(err?.message || err),
        });
    }
});

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
