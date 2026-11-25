---
id: completion-bash
kind: command
category: Autocompletion Scripts
title: completion bash
symbol: supabase completion bash
summary: Generate the Bash completion script
usage: supabase completion bash [flags]
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
    title: Load completions in the current bash session
    lang: sh
    code: source <(supabase completion bash)
---

Generate the autocompletion script for the bash shell.

This script depends on the 'bash-completion' package.
If it is not installed already, you can install it via your OS's package manager.

To load completions in your current shell session:

    source <(supabase completion bash)

To load completions for every new session, execute once:

#### Linux:

    supabase completion bash > /etc/bash_completion.d/supabase

#### macOS:

    supabase completion bash > $(brew --prefix)/etc/bash_completion.d/supabase

You will need to start a new shell for this setup to take effect.
