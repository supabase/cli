---
id: projects-create
kind: command
category: Projects
title: projects create
symbol: supabase projects create
summary: Create a project
usage: supabase projects create [name] [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: name
    location: positional
    required: false
  - name: --db-password
    location: flag
    type: string
    description: Database password for the project.
  - name: --high-availability
    location: flag
    type: boolean
    description: Enable high availability for the project.
    default: false
  - name: --org-id
    location: flag
    type: string
    description: Organization ID to create the project in.
  - name: --region
    location: flag
    type: string
    description: Region to host the project in, ideally close to your users.
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
  - name: --size
    location: flag
    type: string
    description: Instance size of the project.
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
examples:
  - id: example-1
    title: Create a new project
    lang: sh
    code: supabase projects create my-project --org-id cool-green-pqdr0qc --db-password ******** --region us-east-1
---

Create a new Supabase project in an organization.

In an interactive terminal the command prompts for missing values. Without one, you must pass the project name, `--org-id`, `--db-password` and `--region`.
