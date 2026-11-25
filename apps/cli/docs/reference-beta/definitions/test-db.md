---
id: test-db
kind: command
category: testing
subcategory: test
title: test db
symbol: supabase test db
summary: Run database tests with pgTAP
usage: supabase test db [path] ... [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: path
    location: positional
    required: false
    variadic: true
  - name: --remote
    location: flag
    type: boolean | ref|branch|url
    description: "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    default: false
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase test db
    response: |
      /tmp/supabase/tests/nested/order_test.pg .. ok
      /tmp/supabase/tests/pet_test.sql .......... ok
      All tests successful.
      Files=2, Tests=2,  6 wallclock secs ( 0.03 usr  0.01 sys +  0.05 cusr  0.02 csys =  0.11 CPU)
      Result: PASS
---

Run pgTAP tests against a database. By default it runs the `.sql` and `.pg` test files in `supabase/tests`; pass paths to run specific files or directories.

It runs against the local database by default, which requires the local development stack to be started by running `supabase start`. Pass `--remote` for the linked project, or `--remote=<ref|branch|url>` for another project, a branch of the linked project, or a database URL. The command prints a `Target:` line on stderr naming the database it resolved.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

Running the tests enables the pgTAP extension and drops it again afterwards. A hosted database (the linked project or a remote database URL) therefore asks for one confirmation (default No) before anything runs. Piped answers are never read, so a script, a JSON run or an agent must pass `--yes` or set `SUPABASE_YES` in the shell; a `SUPABASE_YES` in `supabase/.env` does not count. The local database never asks.

The tests run with `pg_prove` in a container that mounts your test directory. Each test is wrapped in its own transaction, which is rolled back whether the test passes or fails.
