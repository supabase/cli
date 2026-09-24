# CLI workflow benchmarks

The `Benchmark CLI` GitHub Actions workflow captures raw measurements on
fresh hosted runners. It compiles an immutable CLI source revision and compares it
with a pinned released CLI. Runtime caches are separate from build dependencies.

The stack suite covers cold startup, cached startup with fresh project data,
retained-data restart, and resource usage. The schema suite covers migration diffs,
resets, and declarative schema iteration. Each result records the actual command,
its output, and its outcome. Failed measurements remain part of the dataset.

## Running

Use the workflow's manual inputs to select the source revision, released CLI
version, case set, and sample count. The `docker-stack` case set limits a run to
the five Linux Docker stack cases. Run a single sample first to validate a new CLI revision
or harness change, then collect five independent samples. Do not combine smoke
samples with the final campaign or resume a campaign after changing its source,
artifacts, fixtures, or harness.

Download the workflow's result artifacts before producing a report. Keep raw
samples and environment metadata alongside any aggregate. Compare medians and
ranges within the same runner platform and architecture. Report success counts;
never silently replace failed or slow samples.

## Interpretation

- Default startup compares the user-facing defaults. Lazy database readiness and
  full eager readiness are different endpoints and must be labeled separately.
- Cold command duration includes initialization as well as downloading and
  extraction. It is not a measurement of network transfer time alone.
- Downloaded compressed bytes, extracted cache size, Docker image sizes, process
  RSS, Linux PSS, and container memory accounting are distinct measurements.
  Preserve their labels and do not substitute one for another.
- A command's child-process CPU usage may exclude detached stack hosts and
  containers. Missing metrics are unavailable, not zero.
- Validate generated migrations outside timed intervals. SQL text need not be
  identical if the resulting schema is equivalent.
- GitHub-hosted macOS ARM64 runners support the native cases. Docker cases are
  omitted because these runners do not support nested virtualization. Do not use
  Linux measurements as a macOS Docker baseline.
- Native runs use an unavailable Docker endpoint to verify the Docker-free path.

These scripts operate on disposable CI resources. They must not be used against
an existing developer project or a shared Docker engine.

## Captured cases

Linux runs the released CLI with its default services and with the pooler enabled;
the new CLI runs native and Docker in default, eager, and eager-with-pooler modes.
macOS runs the three native modes. Both platforms also run the new schema suite;
Linux additionally runs it with new Docker and the released CLI. The new stack
is explicitly enabled with `SUPABASE_EXPERIMENTAL_STACK=1`.

Each stack sample captures cold startup, a fresh project with cached artifacts,
and a restart retaining data. Idle memory is sampled after 30, 35, and 40 seconds,
before a lazy REST request. Lazy cases also record reactivation after 65 seconds
without requests. Memory collection includes the managed host process tree and,
on Linux, RSS/PSS of processes in owned containers; Docker working-set statistics
remain separate. Whole-stack startup peak memory is not currently collected.

Preparation runs use a separate native cache. Docker preparation images are removed
after their owning stack is destroyed, and the initial image inventory is checked
before cold startup. The released CLI's separate download measurement replays pulls
of the sample's images after removing them, with four concurrent pulls; this is a
harness-controlled transfer measurement, not the released CLI's own pull scheduler.
Linux network counters include host traffic and protocol overhead. Exact compressed
artifact bytes are unavailable; image sizes and extracted cache sizes must not be
reported as compressed download sizes.

Schema samples record both direct `db diff` and the declarative edit/apply loop on
a small schema and a 101-table schema. The new workflow uses declarative sync;
the released workflow uses diff plus migration application. Generated migrations,
PostgreSQL version, convergence checks, changed-object assertions, and seed checks
are retained. Correctness checks are untimed. Schema process-tree RSS is sampled,
so it can miss short-lived peaks and excludes detached services and containers.
