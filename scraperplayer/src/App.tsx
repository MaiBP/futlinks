import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  AspectRatio,
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Input,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import VideoPlayer from "./components/VideoPlayer";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5179";
const LEGACY_SOURCE_HISTORY_KEY = "m3u8_source_history";
const SOURCE_HISTORY_KEY = "scraperplayer_source_history";
const PLAYLIST_LINKS_KEY = "scraperplayer_playlist_links";
const SOURCE_ENTRIES_KEY = "scraperplayer_source_entries";

type Notice = {
  type: "success" | "error" | "info";
  title: string;
  message?: string;
};

type LinkStatus = "unknown" | "checking" | "active" | "inactive";

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
  bg: string;
  color: string;
  border: string;
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

function parseBulkSources(text: string) {
  const matches = text.match(/https?:\/\/[^\s"'<>()]+/gi) ?? [];
  return normalizeSourceUrls(matches);
}

function extractSourceUrlsFromJson(value: unknown): string[] {
  if (typeof value === "string") return parseBulkSources(value);

  if (Array.isArray(value)) {
    return normalizeSourceUrls(value.flatMap((item) => extractSourceUrlsFromJson(item)));
  }

  if (isRecord(value)) {
    return normalizeSourceUrls(Object.values(value).flatMap((item) => extractSourceUrlsFromJson(item)));
  }

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

  const passwordKey = await window.crypto.subtle.importKey("raw", encodedPassphrase, "PBKDF2", false, [
    "deriveKey",
  ]);
  const aesKey = await window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);
  const text = new TextDecoder().decode(decrypted);
  return JSON.parse(text) as unknown;
}

async function readImportedSourceUrls(fileText: string, passphrase: string) {
  const parsed = JSON.parse(fileText) as unknown;

  if (looksEncryptedSourceFile(parsed)) {
    if (!passphrase.trim()) {
      throw new Error("Enter the file key before importing the encrypted JSON.");
    }

    const decrypted = await decryptSourcesJson(parsed, passphrase.trim());
    return extractSourceUrlsFromJson(decrypted);
  }

  return extractSourceUrlsFromJson(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function getStatusMeta(status: LinkStatus): StatusMeta {
  if (status === "active") {
    return { label: "Active", dot: "green.500", bg: "green.50", color: "green.700", border: "green.200" };
  }

  if (status === "inactive") {
    return { label: "Inactive", dot: "red.500", bg: "red.50", color: "red.700", border: "red.200" };
  }

  if (status === "checking") {
    return { label: "Checking", dot: "yellow.400", bg: "yellow.50", color: "yellow.800", border: "yellow.200" };
  }

  return { label: "Untested", dot: "gray.400", bg: "gray.50", color: "gray.600", border: "gray.200" };
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
    const compact = decoded
      .split(/[&#]/)[0]
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.trim();

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

export default function App() {
  const [sourceUrl, setSourceUrl] = useState("");

  const [sourceFileName, setSourceFileName] = useState("");
  const [sourceFilePassword, setSourceFilePassword] = useState("");
  const [sourceEntries, setSourceEntries] = useState<SourceEntry[]>([]);
  const [bulkChecking, setBulkChecking] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [selectedSourceUrl, setSelectedSourceUrl] = useState<string | undefined>(undefined);
  const [playerRevision, setPlayerRevision] = useState(0);
  const [statusFilter, setStatusFilter] = useState<LinkStatus | "all">("all");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
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
    const history = saved || legacySaved;
    const migratedSources = readStoredSourceEntries(history);

    if (migratedSources.length > 0) {
      setSourceEntries(migratedSources);
      localStorage.setItem(SOURCE_ENTRIES_KEY, JSON.stringify(migratedSources));
    }
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
        entry.sourceUrl === normalized
          ? { ...entry, ...updates, sourceUrl: normalized, status, lastCheckedAt: checkedAt }
          : entry
      );

      if (!exists) next.unshift({ sourceUrl: normalized, ...updates, status, lastCheckedAt: checkedAt });
      return next;
    });
  }

  function removeSourceEntry(sourceUrl: string) {
    updateSourceEntries((prev) => prev.filter((item) => item.sourceUrl !== sourceUrl));
    if (selectedSourceUrl === sourceUrl) {
      setSelected(undefined);
      setSelectedSourceUrl(undefined);
    }
  }

  function clearSourceEntries() {
    setSourceEntries([]);
    localStorage.removeItem(SOURCE_ENTRIES_KEY);
    setSelected(undefined);
    setSelectedSourceUrl(undefined);
  }

  async function checkSourceUrl(source: string): Promise<SourceEntry> {
    const [sourceUrl] = normalizeSourceUrls([source]);
    if (!sourceUrl) throw new Error("Invalid source URL");

    const checkedAt = new Date().toISOString();

    if (isPlaylistUrl(sourceUrl)) {
      return {
        sourceUrl,
        status: "active",
        streamUrl: getProxiedStreamUrl(sourceUrl),
        originalStreamUrl: sourceUrl,
        streams: [sourceUrl],
        lastCheckedAt: checkedAt,
      };
    }

    const res = await axios.post(`${API_URL}/scrape-direct`, { url: sourceUrl });
    const streams = normalizePlaylistUrls(res.data?.results || []);
    const streamUrl = streams[0];

    return {
      sourceUrl,
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
    const [sourceUrl] = normalizeSourceUrls([source]);
    if (!sourceUrl) return null;

    markSourceStatus(sourceUrl, "checking", { error: undefined });

    try {
      const checked = await checkSourceUrl(sourceUrl);
      upsertSourceEntries([checked]);
      return checked;
    } catch (error) {
      const failed: SourceEntry = {
        sourceUrl,
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
      setNotice({
        type: "error",
        title: "No source URLs found",
        message: "The selected JSON file does not contain valid source URLs.",
      });
      setTimeout(() => setNotice(null), 4500);
      return;
    }

    setBulkChecking(true);
    setBulkProgress({ done: 0, total: imported.length });
    upsertSourceEntries(
      imported.map((source) => ({
        sourceUrl: source,
        status: "checking",
        lastCheckedAt: new Date().toISOString(),
      }))
    );

    const results: SourceEntry[] = [];
    for (const source of imported) {
      const checked = await checkAndStoreSource(source);
      if (checked) results.push(checked);
      setBulkProgress((current) => ({ ...current, done: current.done + 1 }));
    }

    const active = results.filter((entry) => entry.status === "active").length;
    const inactive = results.filter((entry) => entry.status === "inactive").length;

    setBulkChecking(false);
    setSourceFileName(fileName);
    setNotice({
      type: "success",
      title: "Sources checked",
      message: `${fileName}: ${active} active, ${inactive} inactive`,
    });
    setTimeout(() => setNotice(null), 4500);
  }

  async function handleSourceFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    const isJsonFile = file.name.toLowerCase().endsWith(".json") || file.type === "application/json" || file.type === "";
    if (!isJsonFile) {
      setNotice({
        type: "error",
        title: "Invalid file",
        message: "Select an encrypted .json file with source URLs.",
      });
      setTimeout(() => setNotice(null), 4500);
      return;
    }

    try {
      setSourceFileName(file.name);
      const text = await file.text();
      await checkImportedSources(text, file.name);
    } catch (error) {
      setBulkChecking(false);
      setNotice({
        type: "error",
        title: "File read failed",
        message: getErrorMessage(error),
      });
      setTimeout(() => setNotice(null), 4500);
    }
  }

  function handleSourcePlay(entry: SourceEntry) {
    if (entry.status !== "active" || !entry.streamUrl) return;

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
    () => sourceEntries.filter((entry) => statusFilter === "all" || entry.status === statusFilter),
    [sourceEntries, statusFilter]
  );

  const selectedSourceLabel = selectedSourceUrl ? getSourceCardLabel(selectedSourceUrl) : "No source selected";

  const noticeStyle = useMemo(() => {
    if (!notice) return null;
    if (notice.type === "success") return { bg: "green.50", border: "green.200", color: "green.800" };
    if (notice.type === "error") return { bg: "red.50", border: "red.200", color: "red.800" };
    return { bg: "blue.50", border: "blue.200", color: "blue.800" };
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
      setNotice({
        type: "info",
        title: "Checking source...",
        message: "Scanning page network for .m3u / .m3u8 links...",
      });

      const checked = await checkAndStoreSource(urlToUse);

      if (checked?.status === "active" && checked.streamUrl) {
        setSelected(checked.streamUrl);
        setSelectedSourceUrl(checked.sourceUrl);
      }

      setNotice({
        type: checked?.status === "active" ? "success" : "error",
        title: checked?.status === "active" ? "Source active" : "Source inactive",
        message:
          checked?.status === "active"
            ? "A playable stream was resolved and saved for this source"
            : checked?.error || "No playable stream was found",
      });
    } catch (err: unknown) {
      setNotice({
        type: "error",
        title: "Error",
        message: getErrorMessage(err),
      });
    } finally {
      setLoading(false);
      setTimeout(() => setNotice(null), 4500);
    }
  }

  function renderStatusFilter(label: string, value: LinkStatus | "all", count: number, meta?: StatusMeta) {
    const active = statusFilter === value;
    const activeBg =
      value === "active"
        ? "green.600"
        : value === "inactive"
          ? "red.600"
          : value === "checking"
            ? "yellow.500"
            : value === "unknown"
              ? "gray.700"
              : "teal.600";
    const activeColor = value === "checking" ? "gray.900" : "white";

    return (
      <Badge
        as="button"
        bg={active ? activeBg : meta?.bg ?? "gray.100"}
        color={active ? activeColor : meta?.color ?? "gray.700"}
        borderWidth="1px"
        borderColor={active ? activeBg : meta?.border ?? "transparent"}
        borderRadius="6px"
        cursor="pointer"
        px={2}
        py={1}
        onClick={() => setStatusFilter(value)}
      >
        {label} {count}
      </Badge>
    );
  }

  return (
    <Flex
      h="100dvh"
      maxH="100dvh"
      bg="#f4f6f5"
      color="gray.900"
      direction={{ base: "column", lg: "row" }}
      overflow="hidden"
    >
      {/* Sidebar / Controls */}
      <Box
        w={sidebarOpen ? { base: "100%", lg: "400px" } : { base: "44px", lg: "48px" }}
        maxW={sidebarOpen ? { base: "100%", lg: "400px" } : { base: "44px", lg: "48px" }}
        bg="#ffffff"
        borderRightWidth={{ base: "0", lg: "1px" }}
        borderBottomWidth={{ base: "1px", lg: "0" }}
        borderColor="gray.200"
        p={sidebarOpen ? { base: 2, md: 5 } : { base: 1.5, md: 2 }}
        h={{ base: sidebarOpen ? "50dvh" : "44px", lg: "100dvh" }}
        maxH={{ base: sidebarOpen ? "50dvh" : "44px", lg: "100dvh" }}
        overflowY={sidebarOpen ? "auto" : "hidden"}
        transition="width 160ms ease, max-width 160ms ease"
        flexShrink={0}
      >
        {!sidebarOpen ? (
          <Button
            size="sm"
            variant="ghost"
            minW="32px"
            h={{ base: "30px", md: "32px" }}
            borderRadius="8px"
            onClick={() => setSidebarOpen(true)}
          >
            &gt;
          </Button>
        ) : (
        <VStack align="stretch" gap={{ base: 3, md: 5 }}>
          <Box>
            <HStack justify="space-between" align="center" gap={3}>
              <Heading size={{ base: "sm", md: "lg" }}>ScraperPlayer</Heading>
              <HStack gap={2}>
                <Badge
                  bg="teal.50"
                  color="teal.700"
                  borderWidth="1px"
                  borderColor="teal.200"
                  borderRadius="6px"
                >
                  HLS
                </Badge>
                <Button
                  size="xs"
                  variant="outline"
                  borderRadius="6px"
                  minW="28px"
                  onClick={() => setSidebarOpen(false)}
                >
                  &lt;
                </Button>
              </HStack>
            </HStack>
            <HStack mt={1} gap={2} wrap="wrap">
              <Badge bg="gray.100" color="gray.700" borderRadius="6px">
                API
              </Badge>
              <Text fontSize="xs" color="gray.500" wordBreak="break-all" lineClamp={1}>
                {API_URL}
              </Text>
            </HStack>
          </Box>

          <Box>
            <HStack justify="space-between" align="center" mb={2}>
              <Text fontSize="sm" fontWeight="semibold">
                Source status
              </Text>
              <Badge bg="gray.100" color="gray.700" borderRadius="6px">
                {sourceEntries.length}
              </Badge>
            </HStack>
            <HStack gap={2} wrap="wrap">
              {renderStatusFilter("All", "all", sourceEntries.length)}
              {renderStatusFilter("Active", "active", sourceStats.active, getStatusMeta("active"))}
              {renderStatusFilter("Inactive", "inactive", sourceStats.inactive, getStatusMeta("inactive"))}
              {renderStatusFilter("Checking", "checking", sourceStats.checking, getStatusMeta("checking"))}
              {renderStatusFilter("Untested", "unknown", sourceStats.unknown, getStatusMeta("unknown"))}
            </HStack>
          </Box>

          <Box>
            <Text fontSize="xs" fontWeight="semibold" color="gray.600" mb={2}>
              Source URL
            </Text>
            <Input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="Paste source URL or direct .m3u8/.m3u"
              size={{ base: "sm", md: "md" }}
              bg="gray.50"
              borderColor="gray.200"
              borderRadius="8px"
              _focusVisible={{
                borderColor: "teal.500",
                boxShadow: "0 0 0 1px var(--chakra-colors-teal-500)",
              }}
            />
          </Box>

          <Button
            bg="#246b5a"
            color="white"
            borderRadius="8px"
            minH="42px"
            _hover={{ bg: "#1b5547" }}
            _disabled={{ opacity: 0.45, cursor: "not-allowed" }}
            onClick={() => runScrape()}
            disabled={!sourceUrl || loading}
          >
            {loading ? (
              <HStack>
                <Spinner size="sm" />
                <Text>Checking...</Text>
              </HStack>
            ) : (
              "Check Source"
            )}
          </Button>

          {notice && noticeStyle && (
            <Box
              p={3}
              borderWidth="1px"
              borderColor={noticeStyle.border}
              bg={noticeStyle.bg}
              borderRadius="8px"
            >
              <Text fontWeight="semibold" color={noticeStyle.color}>
                {notice.title}
              </Text>
              {notice.message && (
                <Text mt={1} fontSize="sm" color={noticeStyle.color}>
                  {notice.message}
                </Text>
              )}
            </Box>
          )}

          <Box h="1px" bg="gray.200" />

          <Box>
            <HStack justify="space-between" align="center" mb={2}>
              <Text fontSize="sm" fontWeight="semibold">
                Import sources
              </Text>
              <Badge bg="gray.100" color="gray.700" borderRadius="6px">
                encrypted .json
              </Badge>
            </HStack>
            <Input
              value={sourceFilePassword}
              onChange={(e) => setSourceFilePassword(e.target.value)}
              type="password"
              placeholder="File key"
              size={{ base: "sm", md: "md" }}
              mb={2}
              bg="gray.50"
              borderColor="gray.200"
              borderRadius="8px"
              _focusVisible={{
                borderColor: "teal.500",
                boxShadow: "0 0 0 1px var(--chakra-colors-teal-500)",
              }}
            />
            <Input
              type="file"
              accept=".json,application/json"
              disabled={bulkChecking}
              onChange={handleSourceFileChange}
              size={{ base: "sm", md: "md" }}
              bg="gray.50"
              borderColor="gray.200"
              borderRadius="8px"
              py={1}
              _focusVisible={{
                borderColor: "teal.500",
                boxShadow: "0 0 0 1px var(--chakra-colors-teal-500)",
              }}
            />
            <HStack mt={2} gap={2} wrap="wrap">
              {bulkChecking && <Spinner size="xs" />}
              <Text fontSize="xs" color="gray.500">
                {bulkChecking
                  ? `Checking ${bulkProgress.done}/${bulkProgress.total}`
                  : sourceFileName || "Select an encrypted JSON source file"}
              </Text>
            </HStack>
          </Box>

          <Box>
            <HStack justify="space-between" align="center" mb={2}>
              <Text fontSize="sm" fontWeight="semibold">
                Sources
              </Text>
              <Badge bg="gray.100" color="gray.700" borderRadius="6px">
                {filteredSourceEntries.length}
              </Badge>
            </HStack>

            {sourceEntries.length === 0 ? (
              <Box
                borderWidth="1px"
                borderStyle="dashed"
                borderColor="gray.200"
                borderRadius="8px"
                bg="gray.50"
                p={3}
              >
                <Text fontSize="sm" color="gray.500">
                  No sources checked yet.
                </Text>
              </Box>
            ) : filteredSourceEntries.length === 0 ? (
              <Box
                borderWidth="1px"
                borderStyle="dashed"
                borderColor="gray.200"
                borderRadius="8px"
                bg="gray.50"
                p={3}
              >
                <Text fontSize="sm" color="gray.500">
                  No sources match this status.
                </Text>
              </Box>
            ) : (
              <VStack align="stretch" gap={2} maxH={{ base: "32dvh", lg: "280px" }} overflowY="auto">
                {filteredSourceEntries.map((entry, idx) => {
                  const statusMeta = getStatusMeta(entry.status);
                  const isSelected = selectedSourceUrl === entry.sourceUrl;
                  const canPlay = entry.status === "active" && Boolean(entry.streamUrl);

                  return (
                    <Box
                      key={`${entry.sourceUrl}-${idx}`}
                      borderWidth="1px"
                      borderColor={isSelected ? "teal.300" : statusMeta.border}
                      borderRadius="8px"
                      bg={isSelected ? "teal.50" : "white"}
                      p={2}
                      _hover={{ borderColor: "teal.300", bg: isSelected ? "teal.50" : "gray.50" }}
                    >
                      <HStack justify="space-between" align="center" gap={2}>
                        <Box as="span" boxSize="8px" borderRadius="full" bg={statusMeta.dot} flex="0 0 auto" />
                        <Badge bg={statusMeta.bg} color={statusMeta.color} borderRadius="6px">
                          {statusMeta.label}
                        </Badge>
                      </HStack>

                      <Text
                        fontSize="xs"
                        mt={1}
                        lineClamp={1}
                        cursor={canPlay ? "pointer" : "default"}
                        fontFamily="mono"
                        color="gray.800"
                        onClick={() => {
                          if (canPlay) handleSourcePlay(entry);
                        }}
                      >
                        {getSourceCardLabel(entry.sourceUrl)}
                      </Text>

                      {entry.error && (
                        <Text mt={1} fontSize="xs" color="red.600" lineClamp={1}>
                          {entry.error}
                        </Text>
                      )}

                      {entry.streams && entry.streams.length > 0 && (
                        <Text mt={0.5} fontSize="xs" color="gray.500">
                          {entry.streams.length} stream{entry.streams.length === 1 ? "" : "s"} resolved
                        </Text>
                      )}

                      <HStack mt={1.5} wrap="wrap" gap={1}>
                        <Button
                          size="xs"
                          bg="teal.600"
                          color="white"
                          borderRadius="6px"
                          _hover={{ bg: "teal.700" }}
                          disabled={!canPlay}
                          onClick={() => handleSourcePlay(entry)}
                        >
                          Play
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          borderRadius="6px"
                          disabled={entry.status === "checking"}
                          onClick={() => void checkAndStoreSource(entry.sourceUrl)}
                        >
                          Retest
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          borderRadius="6px"
                          onClick={() => removeSourceEntry(entry.sourceUrl)}
                        >
                          Remove
                        </Button>
                      </HStack>
                    </Box>
                  );
                })}
              </VStack>
            )}

            {sourceEntries.length > 0 && (
              <Button size="sm" mt={3} variant="outline" borderRadius="8px" onClick={clearSourceEntries}>
                Clear sources
              </Button>
            )}
          </Box>
        </VStack>
        )}
      </Box>

      {/* Player */}
      <Box
        flex="1"
        p={sidebarOpen ? { base: 2, md: 6 } : { base: 1.5, md: 4 }}
        minW={0}
        w="100%"
        h={{ base: sidebarOpen ? "50dvh" : "calc(100dvh - 44px)", lg: "100dvh" }}
        overflow="hidden"
      >
        <VStack align="stretch" gap={sidebarOpen ? { base: 2, md: 4 } : { base: 1.5, md: 3 }} h="100%" minH={0}>
          <HStack justify="space-between" align="start" gap={3} wrap="wrap">
            <Box minW={0}>
              <Heading size={{ base: "sm", md: "md" }} lineClamp={1}>
                {selectedSourceLabel}
              </Heading>
            </Box>
            <Badge
              bg={selected ? selectedStatusMeta.bg : "gray.100"}
              color={selected ? selectedStatusMeta.color : "gray.600"}
              borderWidth="1px"
              borderColor={selected ? selectedStatusMeta.border : "gray.200"}
              borderRadius="6px"
            >
              {selected ? selectedStatusMeta.label : "Idle"}
            </Badge>
          </HStack>

          <Box
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="lg"
            p={{ base: 2, md: 3 }}
            flex="1"
            minH={0}
            overflow="hidden"
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            {selected ? (
              <Box
                w="100%"
                maxW={sidebarOpen ? "100%" : "calc((100dvh - 92px) * 16 / 9)"}
                maxH="100%"
              >
                <AspectRatio ratio={16 / 9} w="100%">
                  <Box w="100%" h="100%">
                    <VideoPlayer
                      key={`${selected}-${playerRevision}`}
                      src={selected}
                      onStatusChange={handlePlayerStatusChange}
                    />
                  </Box>
                </AspectRatio>
              </Box>
            ) : (
              <Text color="gray.500">Select an active source to play.</Text>
            )}
          </Box>
        </VStack>
      </Box>
    </Flex>
  );
}
