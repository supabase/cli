---
id: logout
kind: command
category: general
title: logout
symbol: supabase logout
summary: Log out and delete local credentials
usage: supabase logout [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters: []
examples:
  - id: example-1
    title: Delete the stored access token
    lang: sh
    code: supabase logout
---

Log out of your Supabase account by deleting the stored access token and project database passwords from this machine. The tokens are not revoked on supabase.com.
