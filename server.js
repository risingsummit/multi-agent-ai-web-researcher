import http from "node:http";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const historyFile = path.join(dataDir, "history.json");
loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 8787);
const MAX_RESULTS = 8;
const USER_AGENT = "MultiAgentResearcher/1.0 (+local research app)";

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/research") {
      const body = await readJson(req);
      const result = await runResearch(body.query, body.options || {});
      await saveHistory(result);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/research/stream") {
      const body = await readJson(req);
      return streamResearch(res, body.query, body.options || {});
    }

    if (req.method === "GET" && url.pathname === "/api/history") {
      return sendJson(res, 200, await loadHistory());
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/history/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/history/", ""));
      const item = (await loadHistory()).find((entry) => entry.id === id);
      return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: "History item not found" });
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        provider: configuredProvider().name,
        llm: Boolean(process.env.OPENAI_API_KEY)
      });
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Multi-Agent AI Web Researcher running at http://localhost:${PORT}`);
  console.log(`Search provider: ${configuredProvider().name}`);
  console.log(`LLM synthesis: ${process.env.OPENAI_API_KEY ? "enabled" : "local extractive fallback"}`);
});

async function streamResearch(res, query, options) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  const send = (event, payload) => {
    res.write(`${JSON.stringify({ event, ...payload })}\n`);
  };

  try {
    const result = await runResearch(query, options, (step) => send("step", step));
    await saveHistory(result);
    send("result", { result });
  } catch (error) {
    send("error", { error: error.message || "Unexpected server error" });
  } finally {
    res.end();
  }
}

async function runResearch(query, options, onEvent = () => {}) {
  if (!query || !query.trim()) throw new Error("Query is required.");
  const startedAt = Date.now();
  const trace = [];
  const pushTrace = (step) => {
    trace.push(step);
    onEvent(step);
  };

  const plan = plannerAgent(query, options);
  pushTrace({ agent: "Planner", status: "complete", detail: `${plan.tasks.length} search tasks created`, data: plan.tasks });

  const provider = configuredProvider();
  const searchReport = await searchAgent(provider, plan.tasks);
  const searchResults = searchReport.results;
  pushTrace({
    agent: "Search",
    status: searchReport.errors.length ? "warning" : "complete",
    detail: `${searchResults.length} candidate sources found via ${provider.name}${searchReport.errors.length ? `; ${searchReport.errors.length} task(s) failed` : ""}`
  });

  const sources = await readerAgent(searchResults);
  pushTrace({ agent: "Reader", status: "complete", detail: `${sources.length} sources read and ranked` });

  const synthesis = await synthesisAgent(query, plan, sources, options);
  pushTrace({ agent: "Synthesis", status: "complete", detail: process.env.OPENAI_API_KEY ? "LLM answer generated" : "Local cited synthesis generated" });

  const audited = citationAuditor(synthesis, sources);
  pushTrace({ agent: "Citation Auditor", status: "complete", detail: `${audited.citations.length} citations verified` });

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    query,
    answer: audited.answer,
    citations: audited.citations,
    sources: sources.map(({ title, url, snippet, score, publishedDate, wordCount, sourceType }, index) => ({
      id: index + 1,
      title,
      url,
      snippet,
      score,
      publishedDate,
      sourceType,
      wordCount
    })),
    trace,
    elapsedMs: Date.now() - startedAt,
    provider: provider.name
  };
}

function plannerAgent(query, options) {
  const freshness = options.freshness || "current";
  const base = query.trim();
  const intents = [
    base,
    `${base} latest developments`,
    `${base} key facts sources`
  ];

  if (freshness === "recent") intents.push(`${base} 2026 update`);
  if (options.depth === "deep") intents.push(`${base} analysis evidence`, `${base} criticism limitations`);

  return {
    objective: base,
    tasks: [...new Set(intents)].slice(0, options.depth === "deep" ? 5 : 3)
  };
}

async function searchAgent(provider, tasks) {
  const settled = await Promise.allSettled(tasks.map((task) => provider.search(task, MAX_RESULTS)));
  const flattened = settled.flatMap((item) => item.status === "fulfilled" ? item.value : []);
  const errors = settled
    .filter((item) => item.status === "rejected")
    .map((item) => item.reason?.message || "Search task failed");
  return {
    results: dedupeByUrl(flattened).slice(0, MAX_RESULTS),
    errors
  };
}

async function readerAgent(results) {
  const reads = await Promise.allSettled(results.map(async (result, index) => {
    const pageText = await fetchReadableText(result.url).catch(() => "");
    const text = cleanText([result.snippet, pageText].filter(Boolean).join(" "));
    return {
      ...result,
      text,
      score: scoreSource(result, text, index),
      sourceType: sourceType(result.url),
      wordCount: text ? text.split(/\s+/).length : 0
    };
  }));

  return reads
    .filter((item) => item.status === "fulfilled")
    .map((item) => item.value)
    .filter((source) => source.url && (source.snippet || source.text))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);
}

async function synthesisAgent(query, plan, sources, options) {
  if (process.env.OPENAI_API_KEY) {
    return openAiSynthesis(query, plan, sources, options).catch(() => localSynthesis(query, sources));
  }
  return localSynthesis(query, sources);
}

async function openAiSynthesis(query, plan, sources, options) {
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const sourceBlock = sources.map((source, index) => {
    return `[${index + 1}] ${source.title}\nURL: ${source.url}\nEvidence: ${source.text.slice(0, 1600)}`;
  }).join("\n\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: "You are a careful web research analyst. Answer with concise paragraphs and cite every factual claim using bracketed source numbers like [1]. Only use the provided sources."
        },
        {
          role: "user",
          content: `Question: ${query}\n\nResearch plan: ${plan.tasks.join("; ")}\n\nSources:\n${sourceBlock}\n\nWrite a direct answer, then a short 'What to watch' section when useful.`
        }
      ],
      temperature: options.tone === "creative" ? 0.4 : 0.2
    })
  });

  if (!response.ok) throw new Error(`OpenAI synthesis failed: ${response.status}`);
  const json = await response.json();
  const answer = json.output_text || json.output?.flatMap((part) => part.content || []).map((part) => part.text).join("\n") || "";
  return { answer };
}

function localSynthesis(query, sources) {
  const top = sources.slice(0, 5);
  if (!top.length) {
    return {
      answer: `I could not retrieve usable sources for "${query}". Check network access and confirm that a search provider API key is configured in .env, or use the no-key Wikipedia fallback when outbound access is available.`
    };
  }
  const lead = `Here is a sourced research brief for "${query}".`;
  const bullets = top.map((source, index) => {
    const sentence = bestSentence(source.text || source.snippet || "", query);
    return `- ${sentence || source.snippet || "This source provides relevant context."} [${index + 1}]`;
  });
  const watch = top.length > 1
    ? `\n\nSource coverage is strongest across ${top.length} independent results. For decisions that depend on very recent facts, re-run the search and prefer official or primary sources.`
    : "";
  return { answer: [lead, "", ...bullets].join("\n") + watch };
}

function citationAuditor(synthesis, sources) {
  const answer = synthesis.answer || "No answer could be generated from the available sources.";
  const citedIds = [...answer.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number(match[1]))
    .filter((id) => id >= 1 && id <= sources.length);
  const uniqueIds = [...new Set(citedIds)];
  const citations = uniqueIds.map((id) => ({
    id,
    title: sources[id - 1].title,
    url: sources[id - 1].url
  }));
  return { answer, citations };
}

async function loadHistory() {
  try {
    const text = await readFile(historyFile, "utf8");
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function saveHistory(result) {
  await mkdir(dataDir, { recursive: true });
  const history = await loadHistory();
  const summary = {
    ...result,
    preview: cleanText(result.answer).slice(0, 240)
  };
  const next = [summary, ...history.filter((item) => item.id !== result.id)].slice(0, 30);
  await writeFile(historyFile, JSON.stringify(next, null, 2), "utf8");
}

function configuredProvider() {
  const requested = (process.env.SEARCH_PROVIDER || "").toLowerCase();
  const providers = {
    tavily: tavilyProvider,
    brave: braveProvider,
    bing: bingProvider,
    serpapi: serpApiProvider,
    wikipedia: wikipediaProvider
  };
  const selected = providers[requested]?.();
  if (selected?.configured) return selected;

  for (const create of [tavilyProvider, braveProvider, bingProvider, serpApiProvider]) {
    const provider = create();
    if (provider.configured) return provider;
  }
  return wikipediaProvider();
}

function tavilyProvider() {
  return {
    name: "Tavily",
    configured: Boolean(process.env.TAVILY_API_KEY),
    async search(query, maxResults) {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          search_depth: "advanced",
          include_answer: false,
          max_results: maxResults
        })
      });
      if (!response.ok) throw new Error(`Tavily search failed: ${response.status}`);
      const json = await response.json();
      return (json.results || []).map((item) => normalizeResult({
        title: item.title,
        url: item.url,
        snippet: item.content,
        publishedDate: item.published_date
      }));
    }
  };
}

function braveProvider() {
  return {
    name: "Brave Search",
    configured: Boolean(process.env.BRAVE_API_KEY),
    async search(query, maxResults) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "X-Subscription-Token": process.env.BRAVE_API_KEY
        }
      });
      if (!response.ok) throw new Error(`Brave search failed: ${response.status}`);
      const json = await response.json();
      return (json.web?.results || []).map((item) => normalizeResult({
        title: item.title,
        url: item.url,
        snippet: item.description,
        publishedDate: item.age
      }));
    }
  };
}

function bingProvider() {
  return {
    name: "Bing Web Search",
    configured: Boolean(process.env.BING_API_KEY),
    async search(query, maxResults) {
      const url = new URL("https://api.bing.microsoft.com/v7.0/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      const response = await fetch(url, {
        headers: { "Ocp-Apim-Subscription-Key": process.env.BING_API_KEY }
      });
      if (!response.ok) throw new Error(`Bing search failed: ${response.status}`);
      const json = await response.json();
      return (json.webPages?.value || []).map((item) => normalizeResult({
        title: item.name,
        url: item.url,
        snippet: item.snippet,
        publishedDate: item.dateLastCrawled
      }));
    }
  };
}

function serpApiProvider() {
  return {
    name: "SerpAPI",
    configured: Boolean(process.env.SERPAPI_API_KEY),
    async search(query, maxResults) {
      const url = new URL("https://serpapi.com/search.json");
      url.searchParams.set("q", query);
      url.searchParams.set("api_key", process.env.SERPAPI_API_KEY);
      url.searchParams.set("num", String(maxResults));
      const response = await fetch(url);
      if (!response.ok) throw new Error(`SerpAPI search failed: ${response.status}`);
      const json = await response.json();
      return (json.organic_results || []).map((item) => normalizeResult({
        title: item.title,
        url: item.link,
        snippet: item.snippet,
        publishedDate: item.date
      }));
    }
  };
}

function wikipediaProvider() {
  return {
    name: "Wikipedia fallback",
    configured: true,
    async search(query, maxResults) {
      const url = new URL("https://en.wikipedia.org/w/api.php");
      url.searchParams.set("origin", "*");
      url.searchParams.set("action", "query");
      url.searchParams.set("list", "search");
      url.searchParams.set("format", "json");
      url.searchParams.set("srsearch", query);
      url.searchParams.set("srlimit", String(maxResults));
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) throw new Error(`Wikipedia search failed: ${response.status}`);
      const json = await response.json();
      return (json.query?.search || []).map((item) => normalizeResult({
        title: item.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replaceAll(" ", "_"))}`,
        snippet: stripHtml(item.snippet),
        publishedDate: null
      }));
    }
  };
}

async function fetchReadableText(url) {
  if (!/^https?:\/\//.test(url)) return "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html, text/plain" },
      signal: controller.signal
    });
    if (!response.ok) return "";
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return "";
    const html = await response.text();
    return extractReadableText(html);
  } finally {
    clearTimeout(timeout);
  }
}

function extractReadableText(html) {
  return cleanText(stripHtml(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " "))).slice(0, 6000);
}

function normalizeResult(result) {
  return {
    title: cleanText(result.title || "Untitled source"),
    url: result.url,
    snippet: cleanText(stripHtml(result.snippet || "")),
    publishedDate: result.publishedDate || null
  };
}

function dedupeByUrl(results) {
  const seen = new Set();
  return results.filter((result) => {
    if (!result.url) return false;
    const key = result.url.replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreSource(result, text, index) {
  let score = 100 - index * 4;
  if (result.publishedDate) score += 8;
  if (text.length > 1200) score += 10;
  if (sourceType(result.url) === "primary") score += 12;
  return score;
}

function sourceType(url) {
  if (/\.gov|\.edu|who\.int|un\.org|oecd\.org|worldbank\.org|sec\.gov|federalreserve\.gov/i.test(url)) {
    return "primary";
  }
  if (/wikipedia\.org|britannica\.com/i.test(url)) return "reference";
  return "web";
}

function bestSentence(text, query) {
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 3);
  const sentences = cleanText(text).split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 60 && sentence.length < 260);
  return sentences
    .map((sentence) => ({
      sentence,
      score: terms.reduce((sum, term) => sum + (sentence.toLowerCase().includes(term) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score)[0]?.sentence || sentences[0] || "";
}

function stripHtml(text) {
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function serveStatic(urlPath, res) {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  const ext = path.extname(filePath);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
  let content;
  try {
    content = await readFile(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}
