---
id: test-new
kind: command
category: testing
subcategory: test
title: test new
symbol: supabase test new
summary: Create a new test file
usage: supabase test new <name> [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: name
    location: positional
    required: true
  - name: --template
    location: flag
    type: "[ pgtap ]"
    description: Test framework to generate the file for.
    default: pgtap
    allowed_values:
      - pgtap
    short: -t
examples:
  - id: example-1
    title: Create a pgTAP test file
    lang: sh
    code: supabase test new users
---

Create a test file in supabase/tests to start writing database tests from a template.
