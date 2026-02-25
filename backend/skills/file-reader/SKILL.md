---
name: file-reader
version: 1.0.0
description: Read text files from the project workspace
trigger: when the task depends on local file contents
metadata: {"openclaw":{"emoji":"📄"}}
inputs:
  - path: string (absolute path or path relative to project root)
  - startLine?: number
  - endLine?: number
  - maxLines?: number
outputs:
  - content: string
  - metadata: {path, startLine, endLine, totalLines}
---
Use this skill to quote and analyze source files, configs, or markdown content.
Prefer narrow line ranges to reduce token usage.
