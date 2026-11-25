---
id: logs-sources
kind: command
category: General
subcategory: logs
title: logs sources
symbol: supabase logs sources
summary: List supported sources and filters. Hosted entries describe capabilities and do not imply that rows exist. Local entries list retained stack instances. Use --output-format json|stream-json for structured output; -o/--output is unsupported.
usage: supabase logs sources [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target a remote log source: the linked project, or --remote=<ref|branch>."
    default: false
  - name: --service
    location: flag
    type: string
    description: Describe one service.
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name.
  - name: --stack-id
    location: flag
    type: string
    description: Select a local stack by ID.
examples: []
---

List supported sources and filters. Hosted entries describe capabilities and do not imply that rows exist. Local entries list retained stack instances. Use --output-format json|stream-json for structured output; -o/--output is unsupported.
