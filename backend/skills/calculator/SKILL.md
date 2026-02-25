---
name: calculator
version: 1.0.0
description: Evaluate mathematical expressions precisely
trigger: when exact numeric results are required
metadata: {"openclaw":{"emoji":"🔢"}}
inputs:
  - expression: string (supports +, -, *, /, %, ^, parentheses)
outputs:
  - result: number
---
Use this skill for arithmetic instead of mental estimation. Return both the expression and result.
