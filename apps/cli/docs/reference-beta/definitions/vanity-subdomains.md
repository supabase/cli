---
id: vanity-subdomains
kind: command
category: vanity-subdomains
subcategory: vanity-subdomains
title: vanity-subdomains
symbol: supabase vanity-subdomains
summary: Manage vanity subdomains
stability: stable
deprecated: false
inherits_flags: global
parameters: []
examples: []
---

Gives your project a branded hostname under the Supabase domain instead of the project ref. Vanity subdomains and custom domains are mutually exclusive.

`activate` and `delete` ask for confirmation, with a default of No. Pass `--yes` (or set `SUPABASE_YES` in the shell) to run without a prompt, which JSON output and non-interactive runs require.
