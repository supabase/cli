---
id: whoami
kind: command
category: General
title: whoami
symbol: supabase whoami
summary: Show the current user
usage: supabase whoami [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters: []
examples:
  - id: example-1
    title: Show the current user
    lang: sh
    code: supabase whoami
  - id: example-2
    title: Show the current user as JSON
    lang: sh
    code: supabase whoami --output-format json
---

Show information about the currently logged-in user.
