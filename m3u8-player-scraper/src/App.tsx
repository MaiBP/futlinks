import { useEffect, useMemo, useState } from "react";
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

const API_URL = "http://localhost:5179";
const SOURCE_HISTORY_KEY = "m3u8_source_history";

type Mode = "direct" | "menu";

type Notice = {
  type: "success" | "error" | "info";
  title: string;
  message?: string;
};

function isPlaylistUrl(url: string) {
  const lower = url.toLowerCase();
  return lower.includes(".m3u8") || lower.includes(".m3u");
}

export default function App() {
  const [sourceUrl, setSourceUrl] = useState("");
  const [mode, setMode] = useState<Mode>("direct");

  const [menuSelector, setMenuSelector] = useState("ul.menu");
  const [subSelector, setSubSelector] = useState("ul.menu li.subitem1 a");
  const [limit, setLimit] = useState("");

  const [sourceHistory, setSourceHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [links, setLinks] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(SOURCE_HISTORY_KEY);
    if (saved) setSourceHistory(JSON.parse(saved));
  }, []);

  function saveSourceToHistory(url: string) {
    if (!url.trim()) return;

    setSourceHistory((prev) => {
      const cleanUrl = url.trim();
      const next = [cleanUrl, ...prev.filter((item) => item !== cleanUrl)].slice(0, 20);
      localStorage.setItem(SOURCE_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }

  function removeSourceFromHistory(url: string) {
    setSourceHistory((prev) => {
      const next = prev.filter((item) => item !== url);
      localStorage.setItem(SOURCE_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }

  function clearSourceHistory() {
    setSourceHistory([]);
    localStorage.removeItem(SOURCE_HISTORY_KEY);
  }

  const selectedLabel = useMemo(() => {
    if (!selected) return "No video selected";
    try {
      return new URL(selected).hostname;
    } catch {
      return "Selected stream";
    }
  }, [selected]);

  const noticeStyle = useMemo(() => {
    if (!notice) return null;
    if (notice.type === "success") return { bg: "green.50", border: "green.200", color: "green.800" };
    if (notice.type === "error") return { bg: "red.50", border: "red.200", color: "red.800" };
    return { bg: "blue.50", border: "blue.200", color: "blue.800" };
  }, [notice]);

  async function runScrape(customUrl?: string, customMode?: Mode) {
    const urlToUse = customUrl || sourceUrl;
    const modeToUse = customMode || mode;

    if (!urlToUse) return;

    setLoading(true);
    setLinks([]);
    setSelected(undefined);
    saveSourceToHistory(urlToUse);

    try {
      if (modeToUse === "direct" && isPlaylistUrl(urlToUse)) {
        setLinks([urlToUse]);
        setSelected(urlToUse);

        setNotice({
          type: "success",
          title: "Video loaded",
          message: "Direct playlist link is ready to play",
        });

        return;
      }

      setNotice({
        type: "info",
        title: "Loading...",
        message:
          modeToUse === "direct"
            ? "Scanning page network for .m3u / .m3u8 links..."
            : "Scanning menu items and sublinks...",
      });

      const endpoint = modeToUse === "direct" ? "/scrape-direct" : "/scrape-menu";

      const payload =
        modeToUse === "direct"
          ? { url: urlToUse }
          : {
            url: urlToUse,
            menuSelector,
            subSelector,
            ...(limit.trim() ? { limit: Number(limit) } : {}),
          };

      const res = await axios.post(`${API_URL}${endpoint}`, payload);
      const results: string[] = res.data?.results || [];

      setLinks(results);
      if (results.length > 0) setSelected(results[0]);

      setNotice({
        type: "success",
        title: "Completed",
        message: `Found ${results.length} playlist links`,
      });
    } catch (err: any) {
      setNotice({
        type: "error",
        title: "Error",
        message: err?.response?.data?.details || err?.message || "Unknown error",
      });
    } finally {
      setLoading(false);
      setTimeout(() => setNotice(null), 4500);
    }
  }

  function handleHistoryClick(url: string) {
    setSourceUrl(url);
    setMode("direct");
    runScrape(url, "direct");
  }

  return (
    <Flex
      minH="100vh"
      bg="gray.50"
      direction={{ base: "column", lg: "row" }}
    >
      {/* Sidebar / Controls */}
      <Box
        w={{ base: "100%", lg: "400px" }}
        maxW={{ base: "100%", lg: "400px" }}
        bg="white"
        borderRightWidth={{ base: "0", lg: "1px" }}
        borderBottomWidth={{ base: "1px", lg: "0" }}
        borderColor="gray.200"
        p={{ base: 3, md: 4 }}
        maxH={{ base: "none", lg: "100vh" }}
        overflowY={{ base: "visible", lg: "auto" }}
      >
        <VStack align="stretch" gap={4}>
          <Heading size={{ base: "sm", md: "md" }}>M3U8 Scraper Player</Heading>

          <Box>
            <Text fontSize="sm" mb={2}>
              Mode
            </Text>
            <HStack wrap="wrap">
              <Button
                size="sm"
                variant={mode === "direct" ? "solid" : "outline"}
                onClick={() => setMode("direct")}
              >
                Direct
              </Button>
              <Button
                size="sm"
                variant={mode === "menu" ? "solid" : "outline"}
                onClick={() => setMode("menu")}
              >
                Menu / Nested
              </Button>
            </HStack>
          </Box>

          <Box>
            <Text fontSize="sm" mb={2}>
              Source URL
            </Text>
            <Input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="Paste source URL or direct .m3u8/.m3u"
              size={{ base: "sm", md: "md" }}
            />
          </Box>

          {mode === "menu" && (
            <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={3}>
              <Text fontSize="sm" fontWeight="semibold" mb={2}>
                Menu scrape settings
              </Text>

              <Text fontSize="xs" color="gray.600" mb={1}>
                Menu selector
              </Text>
              <Input value={menuSelector} onChange={(e) => setMenuSelector(e.target.value)} mb={2} />

              <Text fontSize="xs" color="gray.600" mb={1}>
                Sub-links selector
              </Text>
              <Input value={subSelector} onChange={(e) => setSubSelector(e.target.value)} mb={2} />

              <Text fontSize="xs" color="gray.600" mb={1}>
                Limit optional
              </Text>
              <Input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="e.g. 10" />
            </Box>
          )}

          <Button colorScheme="blue" onClick={() => runScrape()} disabled={!sourceUrl || loading}>
            {loading ? (
              <HStack>
                <Spinner size="sm" />
                <Text>{mode === "direct" ? "Loading..." : "Scraping..."}</Text>
              </HStack>
            ) : mode === "direct" ? (
              "Load Video"
            ) : (
              "Start Scraping"
            )}
          </Button>

          {notice && noticeStyle && (
            <Box
              p={3}
              borderWidth="1px"
              borderColor={noticeStyle.border}
              bg={noticeStyle.bg}
              borderRadius="lg"
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

          <HStack justify="space-between">
            <Text fontWeight="semibold">Source history</Text>
            <Badge>{sourceHistory.length}</Badge>
          </HStack>

          {sourceHistory.length === 0 ? (
            <Text fontSize="sm" color="gray.500">
              No source URLs saved yet.
            </Text>
          ) : (
            <VStack align="stretch" gap={2} maxH={{ base: "160px", lg: "180px" }} overflowY="auto">
              {sourceHistory.map((url, idx) => (
                <Box
                  key={`${url}-${idx}`}
                  borderWidth="1px"
                  borderColor="gray.200"
                  borderRadius="md"
                  p={2}
                  _hover={{ bg: "gray.50" }}
                >
                  <Text
                    fontSize="sm"
                    lineClamp={2}
                    cursor="pointer"
                    onClick={() => handleHistoryClick(url)}
                  >
                    {url}
                  </Text>

                  <HStack mt={2} wrap="wrap">
                    <Button size="xs" onClick={() => handleHistoryClick(url)}>
                      Load
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => removeSourceFromHistory(url)}>
                      Remove
                    </Button>
                  </HStack>
                </Box>
              ))}
            </VStack>
          )}

          {sourceHistory.length > 0 && (
            <Button size="sm" variant="outline" onClick={clearSourceHistory}>
              Clear history
            </Button>
          )}

          <Box h="1px" bg="gray.200" />

          <HStack justify="space-between">
            <Text fontWeight="semibold">Found links</Text>
            <Badge>{links.length}</Badge>
          </HStack>

          <Box overflowY="auto" maxH={{ base: "180px", lg: "260px" }} pr={1}>
            {links.length === 0 && !loading ? (
              <Text fontSize="sm" color="gray.500">
                No playlist links found yet.
              </Text>
            ) : (
              <VStack align="stretch" gap={2}>
                {links.map((link, idx) => (
                  <Box
                    key={`${link}-${idx}`}
                    p={2}
                    borderRadius="md"
                    cursor="pointer"
                    bg={selected === link ? "blue.50" : "transparent"}
                    _hover={{ bg: "gray.100" }}
                    onClick={() => setSelected(link)}
                  >
                    <Text fontSize="xs" color="gray.600">
                      #{idx + 1}
                    </Text>
                    <Text fontSize="sm" lineClamp={2}>
                      {link}
                    </Text>
                  </Box>
                ))}
              </VStack>
            )}
          </Box>
        </VStack>
      </Box>

      {/* Player */}
      <Box
        flex="1"
        p={{ base: 3, md: 6 }}
        minW={0}
        w="100%"
      >
        <VStack align="stretch" gap={4} h="100%">
          <Heading size={{ base: "sm", md: "md" }}>Player</Heading>
          <Text color="gray.600" fontSize={{ base: "sm", md: "md" }}>
            {selectedLabel}
          </Text>

          <Box
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="lg"
            p={{ base: 2, md: 3 }}
            flex={{ base: "initial", lg: "1" }}
            minH={{ base: "auto", lg: "520px" }}
            overflow="hidden"
          >
            {selected ? (
              <AspectRatio ratio={16 / 9} w="100%" maxH="100%">
                <Box w="100%" h="100%">
                  <VideoPlayer src={selected} />
                </Box>
              </AspectRatio>
            ) : (
              <Text color="gray.500">Select a playlist link to play.</Text>
            )}
          </Box>

          {selected && (
            <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={4}>
              <Text fontSize="sm" fontWeight="semibold" mb={2}>
                Selected playlist URL
              </Text>
              <Text fontSize="xs" color="gray.600" wordBreak="break-all">
                {selected}
              </Text>
            </Box>
          )}
        </VStack>
      </Box>
    </Flex>
  );
}