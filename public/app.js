const form = document.querySelector("#research-form");
const queryInput = document.querySelector("#query");
const depthInput = document.querySelector("#depth");
const freshnessInput = document.querySelector("#freshness");
const providerEl = document.querySelector("#provider");
const llmEl = document.querySelector("#llm");
const emptyState = document.querySelector("#empty-state");
const loadingState = document.querySelector("#loading-state");
const loadingCopy = document.querySelector("#loading-copy");
const answerCard = document.querySelector("#answer-card");
const answerTitle = document.querySelector("#answer-title");
const answerEl = document.querySelector("#answer");
const elapsedEl = document.querySelector("#elapsed");
const traceCard = document.querySelector("#trace-card");
const traceEl = document.querySelector("#trace");
const sourcesCard = document.querySelector("#sources-card");
const sourcesEl = document.querySelector("#sources");
const historyEl = document.querySelector("#history");
const exportButton = document.querySelector("#export-markdown");
const clearButton = document.querySelector("#clear-view");
const submitButton = form.querySelector("button");

let activeResult = null;
let loadingTimer;

init();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = queryInput.value.trim();
  if (!query) return;

  setLoading(true);
  resetResult(query);

  try {
    const result = await streamResearch(query, {
      depth: depthInput.value,
      freshness: freshnessInput.value
    });
    renderResult(result);
    await loadHistory();
  } catch (error) {
    renderError(error);
  } finally {
    setLoading(false);
  }
});

exportButton.addEventListener("click", () => {
  if (!activeResult) return;
  const markdown = toMarkdown(activeResult);
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(activeResult.query)}.md`;
  link.click();
  URL.revokeObjectURL(url);
});

clearButton.addEventListener("click", () => {
  activeResult = null;
  answerCard.classList.add("hidden");
  traceCard.classList.add("hidden");
  sourcesCard.classList.add("hidden");
  emptyState.classList.remove("hidden");
});

async function init() {
  await Promise.all([initHealth(), loadHistory()]);
}

async function initHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    providerEl.textContent = health.provider;
    llmEl.textContent = health.llm ? "OpenAI" : "Local";
  } catch {
    providerEl.textContent = "Unavailable";
    llmEl.textContent = "Unavailable";
  }
}

async function streamResearch(query, options) {
  const response = await fetch("/api/research/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, options })
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Research failed.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.event === "step") {
        appendTrace(message);
        loadingCopy.textContent = message.detail;
      }
      if (message.event === "result") {
        finalResult = message.result;
      }
      if (message.event === "error") {
        throw new Error(message.error);
      }
    }
  }

  if (!finalResult) throw new Error("The research stream ended without a result.");
  return finalResult;
}

async function loadHistory() {
  try {
    const response = await fetch("/api/history");
    const history = await response.json();
    renderHistory(history);
  } catch {
    historyEl.innerHTML = `<p class="muted">History is unavailable.</p>`;
  }
}

function renderHistory(history) {
  if (!history.length) {
    historyEl.innerHTML = `<p class="muted">Completed research will appear here.</p>`;
    return;
  }

  historyEl.innerHTML = history.slice(0, 8).map((item) => `
    <button class="history-item" data-id="${escapeHtml(item.id)}" type="button">
      <strong>${escapeHtml(item.query)}</strong>
      <span>${formatDate(item.createdAt)} · ${item.sources?.length || 0} sources</span>
    </button>
  `).join("");

  historyEl.querySelectorAll(".history-item").forEach((button) => {
    button.addEventListener("click", async () => {
      const response = await fetch(`/api/history/${encodeURIComponent(button.dataset.id)}`);
      const item = await response.json();
      renderResult(item);
    });
  });
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.querySelector("span").textContent = isLoading ? "Researching" : "Run Research";
  if (isLoading) {
    emptyState.classList.add("hidden");
    loadingState.classList.remove("hidden");
    const messages = ["Starting agents...", "Searching sources...", "Reading pages...", "Checking citations..."];
    let index = 0;
    loadingCopy.textContent = messages[index];
    loadingTimer = setInterval(() => {
      index = (index + 1) % messages.length;
      loadingCopy.textContent = messages[index];
    }, 1400);
  } else {
    loadingState.classList.add("hidden");
    clearInterval(loadingTimer);
  }
}

function resetResult(query) {
  activeResult = null;
  answerTitle.textContent = query;
  elapsedEl.textContent = "";
  answerEl.innerHTML = "";
  traceEl.innerHTML = "";
  sourcesEl.innerHTML = "";
  answerCard.classList.add("hidden");
  sourcesCard.classList.add("hidden");
  traceCard.classList.remove("hidden");
}

function renderResult(payload) {
  activeResult = payload;
  providerEl.textContent = payload.provider;
  answerTitle.textContent = payload.query;
  elapsedEl.textContent = `${(payload.elapsedMs / 1000).toFixed(1)}s`;
  answerEl.innerHTML = formatAnswer(payload.answer, payload.citations || []);
  traceEl.innerHTML = (payload.trace || []).map(renderTrace).join("");
  sourcesEl.innerHTML = (payload.sources || []).map(renderSource).join("");

  emptyState.classList.add("hidden");
  answerCard.classList.remove("hidden");
  traceCard.classList.remove("hidden");
  sourcesCard.classList.remove("hidden");
}

function renderError(error) {
  activeResult = null;
  answerTitle.textContent = "Research failed";
  elapsedEl.textContent = "";
  answerEl.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  answerCard.classList.remove("hidden");
}

function appendTrace(item) {
  traceEl.insertAdjacentHTML("beforeend", renderTrace(item));
}

function formatAnswer(answer, citations) {
  const citationMap = new Map(citations.map((citation) => [citation.id, citation.url]));
  const escaped = escapeHtml(answer || "")
    .replace(/\[(\d+)\]/g, (_, id) => {
      const url = citationMap.get(Number(id));
      return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">[${id}]</a>` : `[${id}]`;
    });

  const blocks = escaped.split(/\n{2,}/);
  return blocks.map((block) => {
    if (block.trim().startsWith("- ")) {
      const items = block.split(/\n/).map((line) => `<li>${line.replace(/^- /, "")}</li>`).join("");
      return `<ul>${items}</ul>`;
    }
    return `<p>${block.replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

function renderTrace(item) {
  const status = item.status || "complete";
  return `
    <div class="trace-item ${escapeHtml(status)}">
      <div>
        <strong>${escapeHtml(item.agent)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </div>
      <small>${escapeHtml(status)}</small>
    </div>
  `;
}

function renderSource(source) {
  const host = safeHost(source.url);
  const type = source.sourceType || "web";
  return `
    <article class="source-item">
      <div class="source-head">
        <a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">[${source.id}] ${escapeHtml(source.title)}</a>
        <span class="source-badge">${escapeHtml(type)}</span>
      </div>
      <p>${escapeHtml(source.snippet || "No snippet available.")}</p>
      <span class="source-meta">${escapeHtml(host)} | score ${Math.round(source.score || 0)} | ${source.wordCount || 0} words read</span>
    </article>
  `;
}

function toMarkdown(result) {
  const sources = (result.sources || [])
    .map((source) => `${source.id}. [${source.title}](${source.url})`)
    .join("\n");
  return `# ${result.query}

${result.answer}

## Sources

${sources}

## Agent Trace

${(result.trace || []).map((step) => `- ${step.agent}: ${step.detail}`).join("\n")}
`;
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatDate(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "research";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
