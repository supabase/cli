---
id: completion-zsh
kind: command
category: autocompletion-scripts
subcategory: completion
title: completion zsh
symbol: supabase completion zsh
summary: Generate the Zsh completion script
usage: supabase completion zsh [flags]
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
    title: Load completions in the current zsh session
    lang: sh
    code: source <(supabase completion zsh)
---

Generate the autocompletion script for the zsh shell.

If shell completion is not already enabled in your environment you will need
to enable it.  You can execute the following once:

    echo "autoload -U compinit; compinit" >> ~/.zshrc

To load completions in your current shell session:

    source <(supabase completion zsh)

To load completions for every new session, execute once:

#### Linux:

    supabase completion zsh > "${fpath[1]}/_supabase"

#### macOS:

    supabase completion zsh > $(brew --prefix)/share/zsh/site-functions/_supabase

You will need to start a new shell for this setup to take effect.
