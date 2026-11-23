# 0034. Config diagnostics print no source text

**Status**: accepted
**Date**: 2026-11-11

## Problem Statement

`supabase config validate` reports every problem in a config file, and a report that quotes the
offending line is easier to act on. A config file holds secrets, though: JWT secrets, SMTP and
provider credentials, URLs with embedded passwords or tokens. Validation output lands in
terminals, CI logs, screen shares and pasted bug reports, so anything it prints should be treated
as public.

Showing source lines while masking the secrets in them proved unreliable. Each masking rule
(a list of keys safe to print, masking by parsed value span, URL redaction, printing only plain
single-line scalars) was followed by a new bypass: multi-line strings, inline tables, string
escapes, quoted keys containing dots, and URLs the redaction pattern did not recognise. Masking
every value kept the frame but removed the information that made it useful.

## Decision

- Config diagnostics identify a problem by key path and `file:line:column`, and never print
  source text or configured values, in any output format.
- The reason and help lines are written from the schema and the problem's kind, never from the
  value. An expected type or the allowed choices may be named; the value that was found may not.
- A problem whose value came from the environment names the variable, not its value.
- This applies to `supabase config validate` and to any later command that reports problems in
  a config file.

## Rationale

- Key paths and positions are enough to find and fix a problem: an editor or `sed -n` gets the
  user to the line, which they can read on their own machine.
- Never printing source text cannot leak, however the file is written. Masking source text has
  to understand every way TOML, JSON and JSONC can encode a value, and has to keep up with them.
- Structured output (`--output-format json`) already carried only codes, paths and positions, so
  text and JSON output now follow the same rule.

## Consequences

### Positive

- Validation output is safe to paste into an issue or keep in a CI log.
- The formatter no longer depends on a value-span scanner or a list of keys safe to print.

### Negative

- A report does not show the offending value, so a user whose problem is the value itself
  (a wrong type or an unknown enum choice) opens the file to see it.
