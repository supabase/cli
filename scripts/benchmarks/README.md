# CLI workflow benchmarks

The `Benchmark CLI` GitHub Actions workflow captures raw measurements on
fresh hosted runners. It compiles an immutable CLI source revision and compares it
with a pinned released CLI. Runtime caches are separate from build dependencies.

The stack suite covers cold startup, cached startup with fresh project data,
retained-data restart, and resource usage. The schema suite covers migration diffs,
resets, and declarative schema iteration. Each result records the actual command,
its output, and its outcome. Failed measurements remain part of the dataset.

## Running

Use the workflow's manual inputs to select the source revision and sample count.
The workflow pins the released CLI version in `LEGACY_VERSION`. Run a single sample first to validate a new CLI revision
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
