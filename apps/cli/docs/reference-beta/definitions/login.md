---
id: login
kind: command
category: general
title: login
symbol: supabase login
summary: Log in to your Supabase account
usage: supabase login [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --name
    location: flag
    type: string
    description: Name to store the token under in your settings.
    default: built-in token name generator
  - name: --no-browser
    location: flag
    type: boolean
    description: Print the login URL without opening a browser.
    default: false
  - name: --token
    location: flag
    type: string
    description: Access token to store instead of using the browser login flow.
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase login
    response: |
      You can generate an access token from https://supabase.com/dashboard/account/tokens
      Enter your access token: sbp_****************************************
      Finished supabase login.
---

Signs the CLI in to your Supabase account, so commands that use the Management API can manage your projects, functions, secrets, and more. By default it opens the browser to complete the login; pass a [personal access token](https://supabase.com/dashboard/account/tokens) with `--token` to skip that.

The token is stored in native credentials storage (the operating system keyring). If that is unavailable, it is written to a plain text file at `<SUPABASE_HOME or ~/.supabase>/access-token`.

> In CI or other environments where you do not want to log in, set the `SUPABASE_ACCESS_TOKEN` environment variable instead.

> The Management API client retries retryable failures up to 5 times by default. Set `SUPABASE_API_MAX_RETRIES` to change that. It counts retries after the first attempt, so `0` sends each request once.
