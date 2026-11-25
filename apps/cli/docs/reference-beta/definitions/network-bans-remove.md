---
id: network-bans-remove
kind: command
category: Network Bans
title: network-bans remove
symbol: supabase network-bans remove
summary: Remove a network ban
usage: supabase network-bans remove [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
  - name: --db-unban-ip
    location: flag
    type: strings
    description: IP address to unblock, comma-separated or repeated.
    variadic: true
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
  - name: --experimental
    location: flag
    type: boolean
    required: true
    description: enable experimental features
    default: false
examples:
  - id: example-1
    title: Unban a single IP address
    lang: sh
    code: supabase network-bans remove --db-unban-ip 203.0.113.7 --experimental --remote=<project-ref>
  - id: example-2
    title: Unban the IP address of this machine
    lang: sh
    code: supabase network-bans remove --experimental --remote=<project-ref>
---

Unblocks banned IP addresses. If you pass no IP, it unblocks the IP address of the machine you run it from.
