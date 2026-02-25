---
name: workspace-shell
version: 1.0.0
description: Run safe allowlisted workspace commands for coding and repository workflows
trigger: when the task requires repo inspection, build/test/lint runs, or git state verification
metadata: {"openclaw":{"emoji":"🛠️","requires":{"anyBins":["rg","git","npm"]}}}
inputs:
  - command: string (allowed: rg, ls, cat, sed, head, tail, wc, git, npm, pnpm, yarn)
  - args?: string[] (arguments passed directly without shell expansion)
  - cwd?: string (absolute path or path relative to workspace root)
  - timeoutMs?: number (200-15000)
outputs:
  - exitCode: number | null
  - stdout: string
  - stderr: string
  - timedOut: boolean
  - durationMs: number
---
Use this skill when deterministic command output improves coding accuracy.
Commands are executed with strict allowlists and workspace path boundaries.
If denied by policy, continue with fallback reasoning and explain limitations.
