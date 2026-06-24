import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Cast, ChevronLeft, FileInput, ListChecks, Loader2, Moon, PanelLeftOpen, Search, Star, Sun } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sidebar, SidebarContent, SidebarHeader, SidebarInset } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import VideoPlayer from "./components/VideoPlayer";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5179";
const LEGACY_SOURCE_HISTORY_KEY = "m3u8_source_history";
const SOURCE_HISTORY_KEY = "scraperplayer_source_history";
const PLAYLIST_LINKS_KEY = "scraperplayer_playlist_links";
const SOURCE_ENTRIES_KEY = "scraperplayer_source_entries";
const FAVORITE_SOURCES_KEY = "scraperplayer_favorite_sources";
const THEME_KEY = "scraperplayer_theme";
const CAST_SENDER_SDK_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

type Notice = {
  type: "success" | "error" | "info";
  title: string;
  message?: string;
};

type LinkStatus = "unknown" | "checking" | "active" | "inactive";
type SidebarMode = "input" | "results";
type ResultFilter = LinkStatus | "all" | "favorites";
type ThemeMode = "light" | "dark";

type SourceEntry = {
  sourceUrl: string;
  status: LinkStatus;
  streamUrl?: string;
  originalStreamUrl?: string;
  streams?: string[];
  error?: string;
  title?: string;
  finalUrl?: string;
  lastCheckedAt?: string;
};

type StatusMeta = {
  label: string;
  dot: string;
  badge: string;
  active: string;
};

function cleanUrl(url: string) {
  return url
    .trim()
    .replace(/&amp;/g, "&")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/[),.]+$/g, "");
}

function isPlaylistUrl(url: string) {
  const lower = url.toLowerCase();
  return lower.includes(".m3u8") || lower.includes(".m3u");
}

function normalizeSourceUrls(urls: string[]) {
  const normalized = urls.map(cleanUrl).filter((url) => /^https?:\/\//i.test(url));
  return Array.from(new Set(normalized));
}

function normalizePlaylistUrls(urls: string[]) {
  const normalized = urls.map(cleanUrl).filter(isPlaylistUrl);
  return Array.from(new Set(normalized));
}

function getProxiedStreamUrl(url: string) {
  if (url.includes("/hls-proxy?url=")) return url;
  return `${API_URL}/hls-proxy?url=${encodeURIComponent(url)}`;
}

function getOriginalStreamUrl(url: string) {
  try {
    const parsed = new URL(url);
    const proxiedUrl = parsed.searchParams.get("url");
    return proxiedUrl || url;
  } catch {
    return url;
  }
}

function getSharedUrlParam(name: string) {
  if (typeof window === "undefined") return "";

  try {
    return new URLSearchParams(window.location.search).get(name) || "";
  } catch {
    return "";
  }
}

function getInitialSharedSourceUrl() {
  const [sourceUrl] = normalizeSourceUrls([getSharedUrlParam("source")]);
  return sourceUrl || "";
}

function getInitialSharedStreamUrl() {
  const [streamUrl] = normalizePlaylistUrls([getSharedUrlParam("stream")]);
  return streamUrl ? getProxiedStreamUrl(streamUrl) : undefined;
}

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function parseBulkSources(text: string) {
  const matches = text.match(/https?:\/\/[^\s"'<>()]+/gi) ?? [];
  return normalizeSourceUrls(matches);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractSourceUrlsFromJson(value: unknown): string[] {
  if (typeof value === "string") return parseBulkSources(value);
  if (Array.isArray(value)) return normalizeSourceUrls(value.flatMap((item) => extractSourceUrlsFromJson(item)));
  if (isRecord(value)) return normalizeSourceUrls(Object.values(value).flatMap((item) => extractSourceUrlsFromJson(item)));
  return [];
}

function base64ToBytes(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function looksEncryptedSourceFile(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.ciphertext === "string" &&
    typeof value.iv === "string" &&
    typeof value.salt === "string"
  );
}

async function decryptSourcesJson(encrypted: Record<string, unknown>, passphrase: string) {
  const salt = base64ToBytes(String(encrypted.salt));
  const iv = base64ToBytes(String(encrypted.iv));
  const ciphertext = base64ToBytes(String(encrypted.ciphertext));
  const iterations = typeof encrypted.iterations === "number" ? encrypted.iterations : 250000;
  const encodedPassphrase = new TextEncoder().encode(passphrase);
  const passwordKey = await window.crypto.subtle.importKey("raw", encodedPassphrase, "PBKDF2", false, ["deriveKey"]);
  const aesKey = await window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted)) as unknown;
}

async function readImportedSourceUrls(fileText: string, passphrase: string) {
  const parsed = JSON.parse(fileText) as unknown;

  if (looksEncryptedSourceFile(parsed)) {
    if (!passphrase.trim()) throw new Error("Enter the file key before importing the encrypted JSON.");
    const decrypted = await decryptSourcesJson(parsed, passphrase.trim());
    return extractSourceUrlsFromJson(decrypted);
  }

  return extractSourceUrlsFromJson(parsed);
}

function coerceStatus(value: unknown): LinkStatus {
  return value === "active" || value === "inactive" || value === "checking" || value === "unknown"
    ? value
    : "unknown";
}

function readStoredSourceEntries(value: string | null) {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    const links = parsed.flatMap((item): SourceEntry[] => {
      if (typeof item === "string") {
        const [sourceUrl] = normalizeSourceUrls([item]);
        return sourceUrl ? [{ sourceUrl, status: "unknown" }] : [];
      }

      if (!isRecord(item)) return [];
      const rawSourceUrl = typeof item.sourceUrl === "string" ? item.sourceUrl : item.url;
      if (typeof rawSourceUrl !== "string") return [];

      const [sourceUrl] = normalizeSourceUrls([rawSourceUrl]);
      if (!sourceUrl) return [];

      const streams = Array.isArray(item.streams)
        ? normalizePlaylistUrls(item.streams.filter((stream): stream is string => typeof stream === "string"))
        : [];
      const [originalStreamUrl] = normalizePlaylistUrls([
        typeof item.originalStreamUrl === "string" ? item.originalStreamUrl : "",
      ]);
      const [streamUrl] = normalizePlaylistUrls([
        typeof item.streamUrl === "string" ? getOriginalStreamUrl(item.streamUrl) : streams[0] ?? "",
      ]);
      const resolvedOriginalStreamUrl = originalStreamUrl || streamUrl || (isPlaylistUrl(sourceUrl) ? sourceUrl : undefined);
      const resolvedStreamUrl = resolvedOriginalStreamUrl ? getProxiedStreamUrl(resolvedOriginalStreamUrl) : undefined;
      const resolvedStreams = streams.length > 0 ? streams : resolvedOriginalStreamUrl ? [resolvedOriginalStreamUrl] : [];

      return [
        {
          sourceUrl,
          status: coerceStatus(item.status),
          streamUrl: resolvedStreamUrl,
          originalStreamUrl: resolvedOriginalStreamUrl,
          streams: resolvedStreams,
          error: typeof item.error === "string" ? item.error : undefined,
          title: typeof item.title === "string" ? item.title : undefined,
          finalUrl: typeof item.finalUrl === "string" ? item.finalUrl : undefined,
          lastCheckedAt: typeof item.lastCheckedAt === "string" ? item.lastCheckedAt : undefined,
        },
      ];
    });

    const byUrl = new Map<string, SourceEntry>();
    for (const link of links) byUrl.set(link.sourceUrl, link);
    return Array.from(byUrl.values());
  } catch {
    return [];
  }
}

function readFavoriteSources(value: string | null) {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return normalizeSourceUrls(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return [];
  }
}

function getStatusMeta(status: LinkStatus): StatusMeta {
  if (status === "active") {
    return { label: "Active", dot: "bg-green-500", badge: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300", active: "bg-green-600 text-white border-green-600" };
  }
  if (status === "inactive") {
    return { label: "Inactive", dot: "bg-red-500", badge: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300", active: "bg-red-600 text-white border-red-600" };
  }
  if (status === "checking") {
    return { label: "Checking", dot: "bg-yellow-400", badge: "border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-300", active: "bg-yellow-500 text-gray-950 border-yellow-500" };
  }
  return { label: "Untested", dot: "bg-gray-400", badge: "border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300", active: "bg-gray-700 text-white border-gray-700" };
}

function getHostnameLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Local source";
  }
}

function getSourceCardLabel(url: string) {
  const cleaned = cleanUrl(url);
  const valueAfterEquals = cleaned.includes("=") ? cleaned.slice(cleaned.lastIndexOf("=") + 1) : cleaned;

  try {
    const decoded = decodeURIComponent(valueAfterEquals);
    const compact = decoded.split(/[&#]/)[0].split("/").filter(Boolean).at(-1)?.trim();
    return compact || getHostnameLabel(url);
  } catch {
    return valueAfterEquals.trim() || getHostnameLabel(url);
  }
}

function getErrorMessage(error: unknown) {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { details?: unknown } | undefined;
    if (typeof data?.details === "string" && data.details.trim()) return data.details;
    if (error.message) return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

function SidebarSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default function App() {
  const [sourceUrl, setSourceUrl] = useState(() => getInitialSharedSourceUrl());
  const [sourceFilePassword, setSourceFilePassword] = useState("");
  const [sourceEntries, setSourceEntries] = useState<SourceEntry[]>([]);
  const [favoriteSources, setFavoriteSources] = useState<string[]>([]);
  const [sourceSearch, setSourceSearch] = useState("");
  const [bulkChecking, setBulkChecking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(() => getInitialSharedStreamUrl());
  const [selectedSourceUrl, setSelectedSourceUrl] = useState<string | undefined>(() => {
    const sharedSource = getInitialSharedSourceUrl();
    return sharedSource || undefined;
  });
  const [playerRevision, setPlayerRevision] = useState(0);
  const [statusFilter, setStatusFilter] = useState<ResultFilter>("all");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("input");
  const [castAvailable, setCastAvailable] = useState(false);
  const [castActive, setCastActive] = useState(false);
  const [castLoading, setCastLoading] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => getInitialTheme());
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    setFavoriteSources(readFavoriteSources(localStorage.getItem(FAVORITE_SOURCES_KEY)));

    const savedSources = readStoredSourceEntries(localStorage.getItem(SOURCE_ENTRIES_KEY));
    if (savedSources.length > 0) {
      setSourceEntries(savedSources);
      return;
    }

    const legacyPlaylistLinks = readStoredSourceEntries(localStorage.getItem(PLAYLIST_LINKS_KEY));
    if (legacyPlaylistLinks.length > 0) {
      setSourceEntries(legacyPlaylistLinks);
      localStorage.setItem(SOURCE_ENTRIES_KEY, JSON.stringify(legacyPlaylistLinks));
      return;
    }

    const saved = localStorage.getItem(SOURCE_HISTORY_KEY);
    const legacySaved = localStorage.getItem(LEGACY_SOURCE_HISTORY_KEY);
    const migratedSources = readStoredSourceEntries(saved || legacySaved);
    if (migratedSources.length > 0) {
      setSourceEntries(migratedSources);
      localStorage.setItem(SOURCE_ENTRIES_KEY, JSON.stringify(migratedSources));
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    let mounted = true;

    function updateCastSessionState() {
      if (!window.cast?.framework) return;
      const castContext = window.cast.framework.CastContext.getInstance();
      const session = castContext.getCurrentSession();
      if (mounted) setCastActive(Boolean(session));
    }

    function initializeCast() {
      if (!window.cast?.framework || !window.chrome?.cast?.media) return;
      const castContext = window.cast.framework.CastContext.getInstance();
      castContext.setOptions({
        receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      castContext.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, updateCastSessionState);
      if (mounted) {
        setCastAvailable(true);
        updateCastSessionState();
      }
    }

    window.__onGCastApiAvailable = (isAvailable) => {
      if (isAvailable) initializeCast();
    };

    if (window.cast?.framework && window.chrome?.cast?.media) {
      initializeCast();
      return () => {
        mounted = false;
      };
    }

    if (!document.querySelector(`script[src="${CAST_SENDER_SDK_URL}"]`)) {
      const script = document.createElement("script");
      script.src = CAST_SENDER_SDK_URL;
      script.async = true;
      document.head.appendChild(script);
    }

    return () => {
      mounted = false;
    };
  }, []);

  function updateSourceEntries(updater: (prev: SourceEntry[]) => SourceEntry[]) {
    setSourceEntries((prev) => {
      const next = updater(prev);
      localStorage.setItem(SOURCE_ENTRIES_KEY, JSON.stringify(next));
      return next;
    });
  }

  function upsertSourceEntries(entries: SourceEntry[]) {
    if (entries.length === 0) return;
    updateSourceEntries((prev) => {
      const byUrl = new Map(prev.map((entry) => [entry.sourceUrl, entry]));
      for (const entry of entries) {
        const existing = byUrl.get(entry.sourceUrl);
        byUrl.set(entry.sourceUrl, {
          ...existing,
          ...entry,
          streams: entry.streams ?? existing?.streams,
          streamUrl: entry.streamUrl ?? existing?.streamUrl,
          originalStreamUrl: entry.originalStreamUrl ?? existing?.originalStreamUrl,
        });
      }
      return Array.from(byUrl.values());
    });
  }

  function markSourceStatus(sourceUrl: string, status: LinkStatus, updates: Partial<SourceEntry> = {}) {
    const [normalized] = normalizeSourceUrls([sourceUrl]);
    if (!normalized) return;
    updateSourceEntries((prev) => {
      const checkedAt = new Date().toISOString();
      const exists = prev.some((entry) => entry.sourceUrl === normalized);
      const next = prev.map((entry) =>
        entry.sourceUrl === normalized ? { ...entry, ...updates, sourceUrl: normalized, status, lastCheckedAt: checkedAt } : entry
      );
      if (!exists) next.unshift({ sourceUrl: normalized, ...updates, status, lastCheckedAt: checkedAt });
      return next;
    });
  }

  function removeSourceEntry(sourceUrlToRemove: string) {
    updateSourceEntries((prev) => prev.filter((item) => item.sourceUrl !== sourceUrlToRemove));
    setFavoriteSources((prev) => {
      const next = prev.filter((item) => item !== sourceUrlToRemove);
      localStorage.setItem(FAVORITE_SOURCES_KEY, JSON.stringify(next));
      return next;
    });
    if (selectedSourceUrl === sourceUrlToRemove) {
      setSelected(undefined);
      setSelectedSourceUrl(undefined);
    }
  }

  function clearSourceEntries() {
    setSourceEntries([]);
    setFavoriteSources([]);
    localStorage.removeItem(SOURCE_ENTRIES_KEY);
    localStorage.removeItem(FAVORITE_SOURCES_KEY);
    setSelected(undefined);
    setSelectedSourceUrl(undefined);
  }

  function toggleFavoriteSource(sourceUrlToToggle: string) {
    setFavoriteSources((prev) => {
      const next = prev.includes(sourceUrlToToggle)
        ? prev.filter((item) => item !== sourceUrlToToggle)
        : [...prev, sourceUrlToToggle];
      localStorage.setItem(FAVORITE_SOURCES_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function checkSourceUrl(source: string): Promise<SourceEntry> {
    const [normalizedSourceUrl] = normalizeSourceUrls([source]);
    if (!normalizedSourceUrl) throw new Error("Invalid source URL");
    const checkedAt = new Date().toISOString();

    if (isPlaylistUrl(normalizedSourceUrl)) {
      return {
        sourceUrl: normalizedSourceUrl,
        status: "active",
        streamUrl: getProxiedStreamUrl(normalizedSourceUrl),
        originalStreamUrl: normalizedSourceUrl,
        streams: [normalizedSourceUrl],
        lastCheckedAt: checkedAt,
      };
    }

    const res = await axios.post(`${API_URL}/scrape-direct`, { url: normalizedSourceUrl });
    const streams = normalizePlaylistUrls(res.data?.results || []);
    const streamUrl = streams[0];

    return {
      sourceUrl: normalizedSourceUrl,
      status: streamUrl ? "active" : "inactive",
      streamUrl: streamUrl ? getProxiedStreamUrl(streamUrl) : undefined,
      originalStreamUrl: streamUrl,
      streams,
      error: streamUrl ? undefined : "No playlist stream was found",
      title: typeof res.data?.title === "string" ? res.data.title : undefined,
      finalUrl: typeof res.data?.finalUrl === "string" ? res.data.finalUrl : undefined,
      lastCheckedAt: checkedAt,
    };
  }

  async function checkAndStoreSource(source: string) {
    const [normalizedSourceUrl] = normalizeSourceUrls([source]);
    if (!normalizedSourceUrl) return null;
    markSourceStatus(normalizedSourceUrl, "checking", { error: undefined });

    try {
      const checked = await checkSourceUrl(normalizedSourceUrl);
      upsertSourceEntries([checked]);
      return checked;
    } catch (error) {
      const failed: SourceEntry = {
        sourceUrl: normalizedSourceUrl,
        status: "inactive",
        error: getErrorMessage(error),
        lastCheckedAt: new Date().toISOString(),
      };
      upsertSourceEntries([failed]);
      return failed;
    }
  }

  async function checkImportedSources(fileText: string, fileName: string) {
    const imported = await readImportedSourceUrls(fileText, sourceFilePassword);
    if (imported.length === 0) {
      setNotice({ type: "error", title: "No source URLs found", message: "The selected JSON file does not contain valid source URLs." });
      setTimeout(() => setNotice(null), 4500);
      return;
    }

    upsertSourceEntries(imported.map((source) => ({ sourceUrl: source, status: "unknown", error: undefined })));
    setSidebarMode("results");
    setNotice({ type: "success", title: "Sources loaded", message: `${fileName}: ${imported.length} sources ready to check on play` });
    setTimeout(() => setNotice(null), 4500);
  }

  async function handleSourceFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const isJsonFile = file.name.toLowerCase().endsWith(".json") || file.type === "application/json" || file.type === "";
    if (!isJsonFile) {
      setNotice({ type: "error", title: "Invalid file", message: "Select an encrypted .json file with source URLs." });
      setTimeout(() => setNotice(null), 4500);
      return;
    }

    try {
      setBulkChecking(true);
      await checkImportedSources(await file.text(), file.name);
      setBulkChecking(false);
    } catch (error) {
      setBulkChecking(false);
      setNotice({ type: "error", title: "File read failed", message: getErrorMessage(error) });
      setTimeout(() => setNotice(null), 4500);
    }
  }

  async function handleSourcePlay(entry: SourceEntry) {
    if (entry.status === "checking") return;

    if (entry.status !== "active" || !entry.streamUrl) {
      setSelected(undefined);
      setSelectedSourceUrl(entry.sourceUrl);
      setNotice({ type: "info", title: "Checking link...", message: "Resolving this source before playback" });
      const checked = await checkAndStoreSource(entry.sourceUrl);

      if (!checked || checked.status !== "active" || !checked.streamUrl) {
        setNotice({ type: "error", title: "Source inactive", message: checked?.error || "No playable stream was found" });
        setTimeout(() => setNotice(null), 4500);
        return;
      }

      setNotice({ type: "success", title: "Source active", message: "Starting playback" });
      setTimeout(() => setNotice(null), 2500);
      setSelected((current) => {
        if (current === checked.streamUrl) setPlayerRevision((revision) => revision + 1);
        return checked.streamUrl;
      });
      setSelectedSourceUrl(checked.sourceUrl);
      return;
    }

    setSelected((current) => {
      if (current === entry.streamUrl) setPlayerRevision((revision) => revision + 1);
      return entry.streamUrl;
    });
    setSelectedSourceUrl(entry.sourceUrl);
  }

  const selectedStatus = useMemo(
    () => sourceEntries.find((entry) => entry.sourceUrl === selectedSourceUrl)?.status ?? "unknown",
    [sourceEntries, selectedSourceUrl]
  );
  const selectedStatusMeta = useMemo(() => getStatusMeta(selectedStatus), [selectedStatus]);
  const sourceStats = useMemo(
    () => ({
      active: sourceEntries.filter((entry) => entry.status === "active").length,
      inactive: sourceEntries.filter((entry) => entry.status === "inactive").length,
      checking: sourceEntries.filter((entry) => entry.status === "checking").length,
      unknown: sourceEntries.filter((entry) => entry.status === "unknown").length,
    }),
    [sourceEntries]
  );
  const filteredSourceEntries = useMemo(
    () => {
      const search = sourceSearch.trim().toLowerCase();
      const filtered = sourceEntries.filter((entry) => {
        const matchesStatus =
          statusFilter === "all" ||
          (statusFilter === "favorites" ? favoriteSources.includes(entry.sourceUrl) : entry.status === statusFilter);
        if (!matchesStatus) return false;
        if (!search) return true;

        const searchable = [
          getSourceCardLabel(entry.sourceUrl),
          entry.sourceUrl,
          entry.title,
          entry.finalUrl,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return searchable.includes(search);
      });

      return filtered.sort((a, b) => Number(favoriteSources.includes(b.sourceUrl)) - Number(favoriteSources.includes(a.sourceUrl)));
    },
    [favoriteSources, sourceEntries, sourceSearch, statusFilter]
  );
  const selectedSourceLabel = selectedSourceUrl ? getSourceCardLabel(selectedSourceUrl) : "No source selected";

  const noticeClass = useMemo(() => {
    if (!notice) return "";
    if (notice.type === "success") return "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300";
    if (notice.type === "error") return "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300";
    return "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300";
  }, [notice]);

  function handlePlayerStatusChange(_streamUrl: string, status: "checking" | "active" | "inactive") {
    if (!selectedSourceUrl) return;
    markSourceStatus(selectedSourceUrl, status, {
      error: status === "inactive" ? "Resolved stream failed to play" : undefined,
    });
  }

  async function runScrape(customUrl?: string) {
    const urlToUse = customUrl || sourceUrl;
    if (!urlToUse) return;
    setLoading(true);
    setSelected(undefined);
    setSelectedSourceUrl(undefined);

    try {
      setNotice({ type: "info", title: "Checking source...", message: "Scanning page network for .m3u / .m3u8 links..." });
      const checked = await checkAndStoreSource(urlToUse);

      if (checked?.status === "active" && checked.streamUrl) {
        setSelected(checked.streamUrl);
        setSelectedSourceUrl(checked.sourceUrl);
      }

      setNotice({
        type: checked?.status === "active" ? "success" : "error",
        title: checked?.status === "active" ? "Source active" : "Source inactive",
        message: checked?.status === "active" ? "A playable stream was resolved and saved for this source" : checked?.error || "No playable stream was found",
      });
    } catch (err: unknown) {
      setNotice({ type: "error", title: "Error", message: getErrorMessage(err) });
    } finally {
      setLoading(false);
      setTimeout(() => setNotice(null), 4500);
    }
  }

  async function toggleCastPlayback() {
    if (!window.cast?.framework || !window.chrome?.cast?.media) {
      setNotice({ type: "error", title: "Cast unavailable", message: "Open the app in Chrome on the same Wi-Fi network as your TV." });
      setTimeout(() => setNotice(null), 4500);
      return;
    }

    const castContext = window.cast.framework.CastContext.getInstance();
    const currentSession = castContext.getCurrentSession();

    if (castActive || currentSession) {
      try {
        setCastLoading(true);
        currentSession?.endSession(true);
        setCastActive(false);
        setNotice({ type: "success", title: "Cast stopped", message: "Playback was disconnected from the TV." });
      } catch (error) {
        setNotice({ type: "error", title: "Cast stop failed", message: getErrorMessage(error) });
      } finally {
        setCastLoading(false);
        setTimeout(() => setNotice(null), 4500);
      }
      return;
    }

    if (!selected || !selectedSourceUrl) {
      setNotice({ type: "error", title: "Nothing to cast", message: "Start a source before sending it to your TV." });
      setTimeout(() => setNotice(null), 3500);
      return;
    }

    try {
      setCastLoading(true);
      setNotice({ type: "info", title: "Opening Cast...", message: "Choose your Android TV or Chromecast device." });
      const session = currentSession || (await castContext.requestSession());
      const mediaInfo = new window.chrome.cast.media.MediaInfo(selected, "application/x-mpegURL");
      mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata();
      mediaInfo.metadata.title = selectedSourceLabel;
      mediaInfo.streamType = window.chrome.cast.media.StreamType.LIVE;
      const request = new window.chrome.cast.media.LoadRequest(mediaInfo);
      request.autoplay = true;
      await session.loadMedia(request);
      setCastActive(true);
      setNotice({ type: "success", title: "Casting", message: "Playback was sent to the TV." });
      setTimeout(() => setNotice(null), 4500);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setNotice({ type: "error", title: "Cast failed", message: getErrorMessage(error) });
      setTimeout(() => setNotice(null), 4500);
    } finally {
      setCastLoading(false);
    }
  }

  function renderStatusFilter(label: string, value: ResultFilter, count: number, meta?: StatusMeta) {
    const active = statusFilter === value;
    return (
      <button
        className={cn(
          "rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors",
          active ? meta?.active ?? "border-[#246b5a] bg-[#246b5a] text-white" : meta?.badge ?? "border-transparent bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300"
        )}
        onClick={() => setStatusFilter(value)}
        type="button"
      >
        {label} {count}
      </button>
    );
  }

  function renderSidebarModeButton(label: string, value: SidebarMode, count?: number) {
    const active = sidebarMode === value;
    return (
      <Button
        className={cn(
          "relative h-10 flex-1 border font-semibold shadow-none",
          active
            ? "border-[#246b5a] bg-[#246b5a] text-white shadow-sm hover:bg-[#1b5547]"
            : "border-gray-200 bg-white text-gray-700 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:border-teal-900 dark:hover:bg-teal-950 dark:hover:text-teal-300"
        )}
        onClick={() => setSidebarMode(value)}
        type="button"
        variant="outline"
      >
        <span>{label}</span>
        {typeof count === "number" && (
          <Badge className={cn(active ? "border-white/30 bg-white/15 text-white" : "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-300")}>
            {count}
          </Badge>
        )}
        {active && <span className="absolute inset-x-3 -bottom-1 h-1 rounded-full bg-[#246b5a]" />}
      </Button>
    );
  }

  return (
    <div className={cn("flex h-dvh max-h-dvh flex-col overflow-hidden bg-[#f4f6f5] text-gray-900 dark:bg-[#0f1715] dark:text-gray-100 lg:flex-row", theme === "dark" && "dark")}>
      <Sidebar open={sidebarOpen}>
        {!sidebarOpen ? (
          <div className="flex h-full items-center gap-2 lg:flex-col lg:items-center">
            <Button
              className="bg-gray-950 text-white hover:bg-gray-800 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200"
              onClick={() => setSidebarOpen(true)}
              size="icon"
              title="Open sidebar"
              type="button"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
            <Button
              className={cn(
                sidebarMode === "input" &&
                  "bg-teal-50 text-teal-700 hover:bg-teal-100 dark:bg-[#246b5a] dark:text-white dark:hover:bg-[#1b5547]"
              )}
              onClick={() => {
                setSidebarMode("input");
                setSidebarOpen(true);
              }}
              size="icon"
              title="Input sources"
              type="button"
              variant="ghost"
            >
              <FileInput className="h-4 w-4" />
            </Button>
            <Button
              className={cn(
                "relative",
                sidebarMode === "results" &&
                  "bg-teal-50 text-teal-700 hover:bg-teal-100 dark:bg-[#246b5a] dark:text-white dark:hover:bg-[#1b5547]"
              )}
              onClick={() => {
                setSidebarMode("results");
                setSidebarOpen(true);
              }}
              size="icon"
              title="Result sources"
              type="button"
              variant="ghost"
            >
              <ListChecks className="h-4 w-4" />
              {sourceEntries.length > 0 && (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#246b5a]" />
              )}
            </Button>
            <Button
              className={cn(
                "lg:mt-auto",
                castActive && "bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-700 dark:text-white dark:hover:bg-red-800"
              )}
              disabled={castLoading || !castAvailable}
              onClick={() => void toggleCastPlayback()}
              size="icon"
              title={castActive ? "Stop cast" : "Cast video"}
              type="button"
              variant="ghost"
            >
              <Cast className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
          <SidebarHeader>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <img
                    alt="D10S"
                    className="h-14 w-auto rounded-md object-contain"
                    src="/d10sLogo.png"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
                      size="xs"
                      title={theme === "dark" ? "Light mode" : "Dark mode"}
                      type="button"
                      variant="outline"
                    >
                      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                    </Button>
                    <Button onClick={() => setSidebarOpen(false)} size="xs" type="button" variant="outline">
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-2 rounded-lg border border-gray-200 bg-white p-1.5 shadow-sm dark:border-gray-800 dark:bg-gray-950">
              {renderSidebarModeButton("Input sources", "input")}
              {renderSidebarModeButton("Result sources", "results", sourceEntries.length)}
            </div>
          </SidebarHeader>

          <SidebarContent>
            {notice && (
              <div className={cn("rounded-lg border p-3", noticeClass)}>
                <p className="font-semibold">{notice.title}</p>
                {notice.message && <p className="mt-1 text-sm">{notice.message}</p>}
              </div>
            )}

            {sidebarMode === "input" ? (
              <>
                <SidebarSection title="Single source">
                  <Input
                    onChange={(event) => setSourceUrl(event.target.value)}
                    placeholder="Paste source URL or direct .m3u8/.m3u"
                    value={sourceUrl}
                  />
                  <Button className="mt-3 min-h-10 w-full" disabled={!sourceUrl || loading} onClick={() => runScrape()} type="button">
                    {loading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Checking...
                      </>
                    ) : (
                      "Check Source"
                    )}
                  </Button>
                </SidebarSection>

                <SidebarSection title="Import sources">
                  <Input
                    className="mb-2"
                    onChange={(event) => setSourceFilePassword(event.target.value)}
                    placeholder="File key"
                    type="password"
                    value={sourceFilePassword}
                  />
                  <Input accept=".json,application/json" disabled={bulkChecking} onChange={handleSourceFileChange} type="file" />
                  {bulkChecking && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Importing sources...</span>
                    </div>
                  )}
                </SidebarSection>
              </>
            ) : (
              <>
                <SidebarSection title="Result sources" action={<Badge>{filteredSourceEntries.length}</Badge>}>
                  <div className="relative mb-3">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <Input
                      className="pl-9"
                      onChange={(event) => setSourceSearch(event.target.value)}
                      placeholder="Search sources..."
                      value={sourceSearch}
                    />
                  </div>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {renderStatusFilter("All", "all", sourceEntries.length)}
                    {renderStatusFilter("Active", "active", sourceStats.active, getStatusMeta("active"))}
                    {renderStatusFilter("Inactive", "inactive", sourceStats.inactive, getStatusMeta("inactive"))}
                    {renderStatusFilter("Checking", "checking", sourceStats.checking, getStatusMeta("checking"))}
                    {renderStatusFilter("Untested", "unknown", sourceStats.unknown, getStatusMeta("unknown"))}
                    {renderStatusFilter("Favorites", "favorites", favoriteSources.length)}
                  </div>
                  {sourceEntries.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-3 text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">No sources loaded yet.</div>
                  ) : filteredSourceEntries.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-3 text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">No sources match this status.</div>
                  ) : (
                    <div className="max-h-[calc(58dvh-170px)] space-y-2 overflow-y-auto lg:max-h-[calc(100dvh-250px)]">
                      {filteredSourceEntries.map((entry, idx) => {
                        const statusMeta = getStatusMeta(entry.status);
                        const isSelected = selectedSourceUrl === entry.sourceUrl;
                        const canPlay = entry.status !== "checking";
                        const isFavorite = favoriteSources.includes(entry.sourceUrl);
                        return (
                          <div
                            className={cn(
                              "rounded-lg border bg-white p-2 transition-colors hover:border-teal-300 hover:bg-gray-50 dark:bg-gray-950 dark:hover:border-teal-700 dark:hover:bg-gray-900",
                              isSelected ? "border-teal-300 bg-teal-50 dark:border-teal-700 dark:bg-teal-950" : statusMeta.badge
                            )}
                            key={`${entry.sourceUrl}-${idx}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className={cn("h-2 w-2 shrink-0 rounded-full", statusMeta.dot)} />
                                <button
                                  className={cn("min-w-0 truncate text-left font-mono text-xs text-gray-800 dark:text-gray-100", canPlay ? "cursor-pointer" : "cursor-default")}
                                  onClick={() => {
                                    if (canPlay) void handleSourcePlay(entry);
                                  }}
                                  type="button"
                                >
                                  {getSourceCardLabel(entry.sourceUrl)}
                                </button>
                                <button
                                  className={cn(
                                    "shrink-0 text-gray-300 transition-colors hover:text-yellow-500",
                                    isFavorite && "text-yellow-500"
                                  )}
                                  onClick={() => toggleFavoriteSource(entry.sourceUrl)}
                                  title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                                  type="button"
                                >
                                  <Star className={cn("h-3.5 w-3.5", isFavorite && "fill-current")} />
                                </button>
                              </div>
                              <Badge className={statusMeta.badge}>{statusMeta.label}</Badge>
                            </div>
                            {entry.error && <p className="mt-1 truncate text-xs text-red-600 dark:text-red-400">{entry.error}</p>}
                            {entry.streams && entry.streams.length > 0 && (
                              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                                {entry.streams.length} stream{entry.streams.length === 1 ? "" : "s"} resolved
                              </p>
                            )}
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              <Button disabled={!canPlay} onClick={() => void handleSourcePlay(entry)} size="xs" type="button">
                                {entry.status === "checking" ? "Checking" : "Play"}
                              </Button>
                              <Button disabled={entry.status === "checking"} onClick={() => void checkAndStoreSource(entry.sourceUrl)} size="xs" type="button" variant="outline">
                                Retest
                              </Button>
                              <Button onClick={() => removeSourceEntry(entry.sourceUrl)} size="xs" type="button" variant="outline">
                                Remove
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {sourceEntries.length > 0 && (
                    <Button className="mt-3" onClick={clearSourceEntries} size="sm" type="button" variant="outline">
                      Clear sources
                    </Button>
                  )}
                </SidebarSection>
              </>
            )}
          </SidebarContent>
          </>
        )}
      </Sidebar>

      <SidebarInset className={cn(sidebarOpen ? "h-[42dvh] p-2 md:p-4 lg:h-dvh lg:p-5" : "h-[calc(100dvh-56px)] p-1.5 md:p-4 lg:h-dvh")}>
        <div className="flex h-full min-h-0 flex-col gap-2 lg:gap-3">
          <div className="flex min-h-8 shrink-0 flex-wrap items-start justify-between gap-2">
            <h2 className="min-w-0 truncate text-base font-semibold md:text-lg">{selectedSourceLabel}</h2>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                className={cn("px-2.5", castActive && "bg-red-600 hover:bg-red-700")}
                disabled={castLoading || !castAvailable}
                onClick={() => void toggleCastPlayback()}
                size="sm"
                title={castActive ? "Stop cast" : "Cast video"}
                type="button"
              >
                <Cast className="h-4 w-4" />
              </Button>
              <Badge className={selected ? selectedStatusMeta.badge : "border-gray-200 bg-gray-100 text-gray-600"}>
                {selected ? selectedStatusMeta.label : "Idle"}
              </Badge>
            </div>
          </div>

          <Card className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-1.5 md:p-2 lg:p-3">
            {selected ? (
              <div
                className={cn(
                  "w-full max-h-full",
                  sidebarOpen
                    ? "lg:max-w-[min(100%,calc((100dvh-104px)*16/9))]"
                    : "max-w-[calc((100dvh-92px)*16/9)]"
                )}
              >
                <div className="aspect-video w-full">
                  <VideoPlayer key={`${selected}-${playerRevision}`} src={selected} onStatusChange={handlePlayerStatusChange} />
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">Select an active source to play.</p>
            )}
          </Card>
        </div>
      </SidebarInset>
    </div>
  );
}
