---
id: completion-powershell
kind: command
category: autocompletion-scripts
subcategory: completion
title: completion powershell
symbol: supabase completion powershell
summary: Generate the PowerShell completion script
usage: supabase completion powershell [flags]
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
    title: Load completions in the current PowerShell session
    lang: sh
    code: supabase completion powershell | Out-String | Invoke-Expression
---

Generate the autocompletion script for powershell.

To load completions in your current shell session:

    supabase completion powershell | Out-String | Invoke-Expression

To load completions for every new session, add the output of the above command
to your powershell profile.
