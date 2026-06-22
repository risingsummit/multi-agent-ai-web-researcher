# Multi-Agent AI Web Researcher

A Perplexity-style research app that plans a query, searches the web through configurable real-time search APIs, reads result pages, synthesizes an answer, and cites sources.

Built as a lightweight full-stack JavaScript app with no required runtime dependencies beyond Node.js. It is designed to be easy to run locally, easy to connect to real web search APIs, and easy to showcase as a portfolio project.

## Features

- Streaming agent progress while research runs
- Configurable live search providers with a no-key Wikipedia fallback
- Optional OpenAI synthesis with a local extractive fallback
- Source ranking, source-type badges, and citation auditing
- Local research history stored in `data/history.json`
- Markdown export for finished briefs

## Run

```powershell
Copy-Item .env.example .env
npm start
```

In this Codex workspace, Node may not be on your PATH. You can run it with the bundled runtime:

```powershell
C:\Users\nguye\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe server.js
```

Open [http://localhost:8787](http://localhost:8787).

## Portfolio Highlights

- Multi-agent orchestration pattern with distinct planner, search, reader, synthesis, and citation-auditing stages
- Real-time web search provider abstraction for Tavily, Brave Search, Bing Web Search, SerpAPI, and Wikipedia fallback
- Streaming UI powered by newline-delimited JSON events
- Local-first persistence for previous research runs
- Citation-first answer rendering with source metadata and Markdown export

## Search Providers

Set `SEARCH_PROVIDER` in `.env` and provide the matching key:

- `tavily`: `TAVILY_API_KEY`
- `brave`: `BRAVE_API_KEY`
- `bing`: `BING_API_KEY`
- `serpapi`: `SERPAPI_API_KEY`
- `wikipedia`: no key, useful for demos

The app automatically falls back to Wikipedia if no paid search key is configured.

## AI Synthesis

Set `OPENAI_API_KEY` to enable LLM synthesis. Without it, the app still works with a local extractive synthesizer that ranks source snippets and produces cited bullet insights.

## Agent Pipeline

1. **Planner Agent** expands the user question into targeted search tasks.
2. **Search Agent** queries the selected real-time search API.
3. **Reader Agent** fetches readable page text and enriches source notes.
4. **Synthesis Agent** writes an answer with numbered citations.
5. **Citation Auditor** removes unsupported claims and reports source coverage.

## API

- `POST /api/research`: returns one complete research result as JSON.
- `POST /api/research/stream`: streams newline-delimited JSON events for agent steps and the final result.
- `GET /api/history`: returns recent saved research runs.
- `GET /api/history/:id`: returns one saved research run.
- `GET /api/health`: returns provider and synthesis status.
