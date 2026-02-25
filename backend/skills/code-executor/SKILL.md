---
name: code-executor
version: 1.0.0
description: Execute JavaScript or Python code in a time-limited sandbox process
trigger: when the task needs concrete computation, simulation, or code validation
metadata: {"openclaw":{"emoji":"💻","requires":{"anyBins":["node","python3"]}}}
inputs:
  - language: "javascript" | "python"
  - code: string
  - timeoutMs?: number
outputs:
  - exitCode: number
  - stdout: string
  - stderr: string
---
Use this skill to run deterministic code instead of approximating results by pure reasoning.
Prefer short, focused programs and summarize what was computed.
