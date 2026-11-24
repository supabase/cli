# CLI migration compatibility

These tests verify current machine output against captures from a pre-migration CLI. The standard
CLI E2E project only reads baselines. Recording is a separate local command and refuses CI.

## Add a command

1. Add `<command>.scenario.ts` and register it in `scenarios.ts`. Define argv, synthetic loopback
   routes and cases there. Each case names its output format and expected exit code. Mark a route
   `required` when reaching it is part of the outcome. `<format>` in argv expands per case.
2. From the repository root, record against a trusted, locally available pre-migration commit:

   ```sh
   bun apps/cli/tests/migration-compat/record.ts <scenario> <git-revision>
   ```

   This builds a temporary Git archive using the revision's lockfile and captures actual stdout,
   stderr, exit code, and ordered requests (including retries) into `<scenario>.baseline.json`. Use `--output <new-file>` to review a
   candidate beside an existing capture. The recorder never replaces a file. Review the revision,
   argv and outputs before adding a new baseline; do not replace one just for timestamps.

3. Build and verify the current CLI:

   ```sh
   pnpm exec turbo run supabase#build
   pnpm --dir apps/cli test:e2e:run tests/migration-compat
   ```

The recorder needs a POSIX shell environment, Git, tar, Bun, Node, pnpm and the revision's
dependencies already populated in the default local pnpm store. It installs offline from the
trusted revision's frozen lockfile, without lifecycle scripts or online policy rechecks. It
supports revisions with this workspace's tracked build inputs and `apps/cli` binary build script,
not older repository layouts. The output's parent must exist and support hard links.

Subprocesses get a fresh home and working directory, fake credentials, disabled telemetry and
update checks, a loopback profile, and no ambient credentials or proxy settings. Fixtures must
stay local. This is not an OS sandbox for untrusted revisions or binaries.
