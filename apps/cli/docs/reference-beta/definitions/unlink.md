---
id: unlink
kind: command
category: General
title: unlink
symbol: supabase unlink
summary: Unlink from the hosted Supabase project
usage: supabase unlink [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters: []
examples:
  - id: example-1
    title: Unlink the current directory from its hosted project
    lang: sh
    code: supabase unlink
---

Remove the link between the local project and its hosted Supabase project. Use it before linking to a different project.

The command deletes the local `supabase/.temp` directory and the stored database password for the linked project. Your access token is left untouched.
