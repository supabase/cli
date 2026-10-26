# Security Policy

Thank you for helping keep the Supabase CLI and its users safe.

## Reporting a vulnerability

Please report suspected vulnerabilities through our HackerOne program:
<https://hackerone.com/supabase>. Please do not open public GitHub issues or
pull requests for security problems.

The program-wide rules (out-of-scope categories, testing, disclosure) are
repeated in full at the end of this file. They also live at
<https://supabase.com/.well-known/security.txt>.

This repository contains the Supabase CLI. It runs on a developer's machine or
in CI, starts the local development stack (`supabase start`), manages
migrations, deploys and downloads Edge Functions, and talks to the hosted
Supabase Management API on the user's behalf. There is no hosted CLI: the
target is the CLI and the local stack it starts on your own machine. Issues in
the hosted Management API itself are not tracked in this repository. Report
them through HackerOne as usual and say which API you tested.

## What we consider a vulnerability

In general, we want to hear about anything that lets an attacker get a CLI
user's credentials, act as that user, or run code or write files on their
machine without the user choosing to: obtaining a Supabase access token or
project secret the attacker should not have, redirecting the CLI's
credentials to a server the user did not choose, connecting to a database or
API without properly verifying who is on the other end, or turning data that
the CLI downloads into a write outside the location it was meant for. The 
attacker should not need the victim's credentials or a shell on the
victim's machine, and the problem should be present in a released version of
the CLI used as documented.

Examples of what this includes (these are illustrations, not a complete list):

- **Theft of a CLI access token.** Getting a user to complete a CLI login, or
  any other flow, in a way that hands the resulting access token to the
  attacker.
- **Writes outside the intended directory.** Content the CLI downloads (for
  example a function bundle or its file paths) that makes the CLI create or
  overwrite files outside the project directory it was asked to write to. Show
  the file actually written to a location of the attacker's choosing.
- **Secret exposure.** An access token, database password or project secret
  key written to output, logs or local files in a place where the CLI is meant
  to redact or omit it.
- **Credentials sent to the wrong place.** Project or repository content that
  the CLI reads, such as a `.env` file or `config.toml`, that changes where the
  CLI sends its access token or which server it talks to, without the user
  choosing that.
- **Server identity not verified.** A CLI connection that carries credentials or
  data, such as to the project database or the Management API, that does not
  verify the server's TLS certificate and hostname, or that silently accepts a
  weaker mode than the user asked for. This is in scope even though exploiting
  it needs a network position between the user and the server: the CLI is
  expected to protect those connections, so it is not the MITM exclusion
  below. Show which command connects, what the attacker intercepts, and the
  CLI version.

## What we do not consider a vulnerability

Reports that rely on the behavior below will normally be closed as
informative or not applicable.

**By design**

- **The local development stack is for your own workstation.** The stack that
  `supabase start` runs is meant for local development. It has no
  authorization or isolation layer suitable for the internet, and our
  documentation says it should not be exposed publicly. Reports against a
  local stack that someone has made reachable from the internet are reports
  about that deployment, not about the CLI. If you believe the same issue
  affects a self-hosted deployment, reproduce it using the self-hosting guide
  and say so.
- **The CLI uses credentials that are already present.** If an access token is
  set in the environment (`SUPABASE_ACCESS_TOKEN`) or saved by an earlier
  `supabase login`, commands that call the Management API will use it without
  prompting. A command that "works without logging in" on a machine or agent
  session that already holds a token is not an authentication bypass. Retest in
  a clean environment.
- **The CLI acts with its user's privileges.** Running SQL, pushing
  migrations, deploying functions or managing secrets for projects the token
  can reach is the purpose of the tool.

**Prerequisites that make the attack pointless**

- The attacker needs the victim's access token, database password or project
  secret key.
- The attacker already has a shell, or write access to the user's home
  directory, on the victim's machine.
- The attacker needs owner or admin rights on the victim's project or
  organization, and the action is one those rights already allow.

**Reports that are not evidence of a flaw**

- **Credentials in the git history of this repository** that are revoked or no
  longer valid, including values in old or commented-out config templates.
  Show that a credential is live and grants access.
- **Static analysis or scanner output** with no working proof of concept
  against a released CLI version.

## Out of scope for every Supabase asset

These are excluded program-wide (see also
<https://supabase.com/.well-known/security.txt>). They are repeated here so
you do not need to leave this repository to find them.

- Clickjacking on pages with no sensitive actions.
- Unauthenticated, logout and login CSRF.
- Attacks requiring MITM or physical access to a user's device.
- Attacks requiring social engineering.
- Any activity that could lead to the disruption of our service (DoS).
  This means volumetric attacks, load testing and flooding. A vulnerability in
  our code that lets an unprivileged attacker crash a service or exhaust
  resources for other users or tenants is in scope. Denial of service that only
  affects the attacker's own project, or that needs admin or owner privileges,
  is not.
- Content spoofing and text injection issues without showing an attack vector,
  or without being able to modify HTML/CSS.
- Email spoofing.
- Missing DNSSEC, CAA or CSP headers.
- Lack of Secure or HttpOnly flags on non-sensitive cookies.
- Dead links.
- User enumeration.

The sections above list what is *specific* to this repository.

## Known and documented behavior

These are described in our public documentation. Please check them before
reporting.

- **Local development is not self-hosting.** The local development guide and
  the self-hosting guide describe different setups. The local stack is not
  intended to be exposed outside the developer's machine.
- **`SUPABASE_ACCESS_TOKEN`** can be set in the environment to authenticate the
  CLI without an interactive login, for example in CI.

## Local development stack vs. custom setups

If your finding only applies when someone exposes the local stack to a
network, changes its `config.toml` defaults, or runs a modified CLI, label it
"local CLI, custom configuration" and list what you changed (see below). We
accept findings against released CLI versions used as documented. We treat findings 
that need the user to misconfigure their environment first as lower severity.

## How to write a report that gets triaged quickly

- **Say what you tested, at the top of the report and in the title.** Use one of
  these labels, for example `[Local CLI] ...` in the title and a "Target" line
  at the start of the description:
  - **Local CLI, default configuration**: a released CLI version, and the local
    stack it starts, used exactly as our documentation describes with the
    default `config.toml`. Include the CLI version, how you installed it, and
    your operating system.
  - **Local CLI, custom configuration**: you changed `config.toml`, exposed the
    local stack beyond your machine, built from a branch, or modified code. List
    every change and why. We triage these lower unless the setting is one we
    recommend or document.

  Reports that do not say which of the two they are about are slower to
  triage, and are often closed with a request to retest. A finding that works
  only on a custom configuration is not a finding against a default install.
- **Test a real setup.** Run the released CLI binary, not only code you copied
  out of it. Code reading alone is rarely enough. Static analysis findings need
  a working proof of concept, and the code you cite must match the current
  repository.
- **Give a short, runnable PoC.** The exact commands, any files or server
  responses the attacker controls, and the output showing the impact, such as
  the file written or the token received.
- **State the attacker's starting position.** What do they control (a function
  in an organization the victim belongs to, a web page, a leaked key)? What
  does the victim have to run? Reports that quietly assume a token already in
  the environment, or a shell on the victim's machine, are our most common
  reason to close.
- **Name the boundary you crossed.** Which user, project or organization could
  not do this before, or which location could the attacker not write to? If
  nothing was crossed, it is probably a hardening suggestion.
- **Check the docs and this file first.** If the behavior is documented, explain
  why the documented design still fails.
- **Include versions.** The CLI version, installation method, operating system,
  and whether any `SUPABASE_*` environment variables were set.
- **One issue per report.** Link variants of the same root cause instead of
  filing each variant separately.
- **Do not send unreviewed AI output.** Reports that were not reproduced by a
  human and that ignore the documentation are closed. AI-assisted analysis is
  fine when you have verified the result. If an AI agent ran the CLI for you,
  say whether it had logged in or had a token.
- **Respond to follow-up questions.** Reports that go quiet after we ask for a
  reproduction are closed.

## Severity

We rate severity by realistic impact on a default setup. Issues that need user
interaction the user can see, a deliberately exposed local stack, or an
existing privilege are rated lower even when they are valid, and we may fix
them as defense in depth.

## Testing and disclosure

These are our program-wide rules. They also apply to AI agents and automated
tools acting on your behalf.

**Testing**

- Do not run automated scanners against other customers' projects. Scanners can
  run up costs for our users, can disrupt services, and our own security
  systems cannot tell hostile reconnaissance from research. If you want to run
  an automated scanner, notify security@supabase.com first and run it only on
  your own Supabase project.
- Do not attack projects that belong to other customers.
- Do not take advantage of a vulnerability you find, for example by downloading
  more data than necessary to demonstrate it, or by deleting or modifying other
  people's data.

**Reporting**

- File a report through our HackerOne program at <https://hackerone.com/supabase>.
- Give enough information for us to reproduce the problem.

**Disclosure**

- Do not reveal the problem to others until we have researched and fixed it and
  informed affected customers.
- If you want to share your research publicly (a conference, a blog or any
  other public forum), send us a draft for review and approval at least 30 days
  before the publication date. Do not include data about Supabase customer
  projects, customers' data, or information about Supabase employees,
  contractors or partners.

**What we promise**

- We will respond to your report within 5 business days with our evaluation and
  an expected resolution date.
- If you have followed these instructions, we will not take legal action against
  you in regard to the report.
- We will handle your report with strict confidentiality and will not pass on
  your personal details to third parties without your permission.
- We will keep you informed of our progress.
- In public information about the problem, we will name you as the discoverer
  unless you prefer otherwise.
