---
name: web-search
version: 1.0.0
description: Search the web for real-time information
trigger: when the task requires current facts, news, or data
metadata: {"openclaw":{"emoji":"🌐"}}
inputs:
  - query: string (what to search for)
  - limit?: number (max results, default 5)
outputs:
  - results: array of {title, url, snippet}
  - provider: string (tavily | serper | duckduckgo)
---
Use this skill when you need information that may be recent or that
requires verification from external sources.
Provider order: Tavily -> Serper -> DuckDuckGo fallback.
