---
id: branches-create
kind: command
category: branches
subcategory: branches
title: branches create
symbol: supabase branches create
summary: Create a preview branch
usage: supabase branches create [name] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: name
    location: positional
    required: false
  - name: --git-branch
    location: flag
    type: string
    description: Git branch to associate with the new preview branch.
  - name: --notify-url
    location: flag
    type: string
    description: URL to notify when the branch is active and healthy.
  - name: --persistent
    location: flag
    type: boolean
    description: Create a persistent branch instead of an ephemeral one.
    default: false
  - name: --region
    location: flag
    type: string
    description: Region to deploy the branch database in.
    allowed_values:
      - ap-east-1
      - ap-northeast-1
      - ap-northeast-2
      - ap-south-1
      - ap-southeast-1
      - ap-southeast-2
      - ca-central-1
      - eu-central-1
      - eu-central-2
      - eu-north-1
      - eu-west-1
      - eu-west-2
      - eu-west-3
      - sa-east-1
      - us-east-1
      - us-east-2
      - us-west-1
      - us-west-2
  - name: --remote
    location: flag
    type: boolean | ref
    description: "Target another project: --remote=<ref>. Defaults to the linked project."
    default: false
  - name: --size
    location: flag
    type: string
    description: Instance size of the branch database.
    allowed_values:
      - large
      - medium
      - micro
      - 12xlarge
      - 16xlarge
      - 24xlarge
      - 24xlarge_high_memory
      - 24xlarge_optimized_cpu
      - 24xlarge_optimized_memory
      - 2xlarge
      - 48xlarge
      - 48xlarge_high_memory
      - 48xlarge_optimized_cpu
      - 48xlarge_optimized_memory
      - 4xlarge
      - 8xlarge
      - small
      - xlarge
  - name: --with-data
    location: flag
    type: boolean
    description: Clone production data into the branch database.
    default: false
examples:
  - id: example-1
    title: Create a preview branch
    lang: sh
    code: supabase branches create my-branch
  - id: example-2
    title: Create a persistent branch tied to a git branch
    lang: sh
    code: supabase branches create my-branch --git-branch feature/login --persistent
---

Create a preview branch of the linked project, optionally tied to a git branch.

Pass `--with-data` to clone production data into the branch database.
