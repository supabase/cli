# pg-delta next: deferred follow-ups

Findings from the pg-delta-next bundling review (PR #6102) that were triaged as
**explicitly deferred** — understood, judged not worth acting on for this change, and
recorded here so a later reviewer does not have to rediscover them.

- **The next-engine declarative writer follows symlinked managed directories on write.**
  `apps/cli/src/legacy/commands/db/shared/legacy-pgdelta.write.ts`'s next write loop
  (`writeNextDeclarativeSchemas`) resolves each proposed file's path and writes it with no
  containment check, so a symlinked subdirectory under the declarative dir is written
  through, while the read path (`readManagedDeclarativeSqlFiles` in the same file) skips
  symlinks outright. Asymmetric, but every path written comes from pg-delta's own export
  names (already validated by `safeDeclarativeExportName`), so reaching outside the tree
  needs the user to have planted the symlink themselves. Deferred — not needed now.

- **`generate --output` containment is a lexical guard.**
  `apps/cli/src/legacy/commands/db/schema/declarative/generate/generate.handler.ts`
  rejects an output dir that resolves to or contains the project dir using `path.resolve`
  + `path.relative` only, so an ancestor symlink can make an escaping path look contained.
  The catastrophic outcome (a recursive wipe of the resolved dir) only exists on the legacy
  full-wipe writer; the next writer never removes anything it does not own. Deferred.

- **Shadow host-port allocation probes the wrong host.**
  The shadow-database port allocator probes `127.0.0.1` inside the CLI process but the
  container publishes on the Docker *daemon's* host, so with a remote `DOCKER_HOST` the
  probe can report a free port that is taken remotely (or vice versa). Pre-existing latent
  pattern, copied verbatim from
  `apps/cli/src/legacy/shared/legacy-edge-runtime-script.layer.ts`; not introduced by this
  PR and unreachable for the local-Docker default. Deferred.
