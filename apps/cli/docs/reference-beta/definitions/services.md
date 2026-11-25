---
id: services
kind: command
category: Services
title: services
symbol: supabase services
summary: Show Supabase service versions
usage: supabase services [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters: []
examples:
  - id: example-1
    title: Show local and linked service versions
    lang: sh
    code: supabase services
---

Show the version of each Supabase service in your local stack and, when the project is linked, the version running on the hosted project. Use it to spot a local stack that lags behind.
