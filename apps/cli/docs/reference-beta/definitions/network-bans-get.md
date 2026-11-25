---
id: network-bans-get
kind: command
category: network-bans
subcategory: network-bans
title: network-bans get
symbol: supabase network-bans get
summary: Get the current network bans
usage: supabase network-bans get [flags]
stability: experimental
deprecated: false
inherits_flags: global
parameters:
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
    title: List banned IPs for a project
    lang: sh
    code: supabase network-bans get --experimental --remote=<project-ref>
---

Lists the IP addresses currently banned from connecting to your project's database.
