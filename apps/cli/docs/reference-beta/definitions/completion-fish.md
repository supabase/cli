---
id: completion-fish
kind: command
category: autocompletion-scripts
subcategory: completion
title: completion fish
symbol: supabase completion fish
summary: Generate the fish completion script
usage: supabase completion fish [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --no-descriptions
    location: flag
    type: boolean
    description: Omit descriptions from the generated completions.
    default: false
examples:
  - id: example-1
    title: Load completions in the current fish session
    lang: sh
    code: supabase completion fish | source
---

Generate the autocompletion script for the fish shell.

To load completions in your current shell session:

    supabase completion fish | source

To load completions for every new session, execute once:

    supabase completion fish > ~/.config/fish/completions/supabase.fish

You will need to start a new shell for this setup to take effect.
