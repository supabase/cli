---
id: functions-new
kind: command
category: Edge Functions
title: functions new
symbol: supabase functions new
summary: Create an Edge Function locally
usage: supabase functions new <Function name> [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: Function name
    location: positional
    required: true
  - name: --auth
    location: flag
    type: "[ none | apikey | user ]"
    description: Auth mode to scaffold the function with.
    default: apikey
    allowed_values:
      - none
      - apikey
      - user
examples:
  - id: example-1
    title: Create a new function
    lang: sh
    code: supabase functions new my-function
  - id: example-2
    title: Create a function with the user auth mode
    lang: sh
    code: supabase functions new my-function --auth user
---

Scaffold a starter Edge Function in `supabase/functions/<name>`, ready to edit and serve locally.

The function is a new directory with the name you specify, containing an `index.ts` with the Deno imports and a basic function structure.

After creating the function, edit it, test it with `supabase functions serve`, then publish it with `supabase functions deploy`.
