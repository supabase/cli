---
id: encryption-update-root-key
kind: command
category: encryption
subcategory: encryption
title: encryption update-root-key
symbol: supabase encryption update-root-key
summary: Update the root encryption key
usage: supabase encryption update-root-key [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Update the root encryption key, entering the new key at the prompt
    lang: sh
    code: supabase encryption update-root-key
  - id: example-2
    title: Update the root encryption key from stdin without confirmation
    lang: sh
    code: echo "<new-root-key>" | supabase encryption update-root-key --yes
---

Replace the root encryption key of the project with a new one. The new key is read from a masked prompt, or from piped stdin when there is no terminal.

Asks for confirmation before changing anything; pass `--yes` in scripts and CI.
