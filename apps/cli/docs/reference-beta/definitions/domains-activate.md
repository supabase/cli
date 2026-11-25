---
id: domains-activate
kind: command
category: Custom Domains
title: domains activate
symbol: supabase domains activate
summary: Activate the custom hostname for a project
usage: supabase domains activate [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --remote
    location: flag
    type: boolean | ref|branch
    description: "Target another project: --remote=<ref|branch>. Defaults to the linked project."
    default: false
examples:
  - id: example-1
    title: Activate the custom hostname for a project
    lang: sh
    code: supabase domains activate --remote=abcdefghijklmnopqrst
---

Makes your project respond to requests on its custom hostname. Use it once your hostname is set up and you are ready to switch over from the Supabase-provisioned subdomain.

After the custom hostname is activated, your project's third-party auth providers will no longer function on the Supabase-provisioned subdomain. See [Prepare to activate your domain](/docs/guides/platform/custom-domains#prepare-to-activate-your-domain) for the steps to follow first.

It asks for confirmation before activating, with a default of No. Pass `--yes` (or set `SUPABASE_YES` in the shell) to run without a prompt, which JSON output and non-interactive runs require.
