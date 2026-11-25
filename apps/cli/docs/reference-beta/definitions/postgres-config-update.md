---
id: postgres-config-update
kind: command
category: postgres-config
subcategory: postgres-config
title: postgres-config update
symbol: supabase postgres-config update
summary: Update Postgres database config
usage: supabase postgres-config update [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: --config
    location: flag
    type: strings
    description: Config override as a `key=value` pair, comma-separated or repeated.
    variadic: true
  - name: --no-restart
    location: flag
    type: boolean
    description: Do not restart the database after updating config.
    default: false
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
  - name: --replace-existing-overrides
    location: flag
    type: boolean
    description: If true, replaces all existing overrides with the ones provided. If false (default), merges existing overrides with the ones provided.
    default: false
  - name: --experimental
    location: flag
    type: boolean
    required: true
    description: enable experimental features
    default: false
examples:
  - id: example-1
    title: Set a Postgres config override
    lang: sh
    code: supabase postgres-config update --config work_mem=100MB --experimental --remote=<project-ref>
  - id: example-2
    title: Replace all overrides without restarting
    lang: sh
    code: supabase postgres-config update --config work_mem=100MB --replace-existing-overrides --no-restart --experimental --remote=<project-ref>
---

Sets Postgres setting overrides for your project. Overriding the default Postgres config could result in unstable database behavior.

Custom configuration also overrides the optimizations generated based on the compute add-ons in use.

The update asks for confirmation (default No) before changing the overrides. Pass `--yes` to confirm without asking; JSON, stream-json, `-o` and non-interactive runs fail without it.
