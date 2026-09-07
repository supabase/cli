# Source snapshots

These are sanitized campaign inputs for the derived comparison.

- `legacy-benchmark-data.json` and `legacy-process-memory-data.json`: historical Supabase CLI 2.116.0 campaign on macOS and Ubuntu 22.04.5 LTS.
- `optimized-benchmark-data.json` and `optimized-samples.json`: optimized stack campaign based on PR head `1944456f2` plus the local optimization patch.
- `optimized-artifacts.json`: tested native archive and Docker image identities. Patch hashes are in `optimized-benchmark-data.json`; the full Nix release build was not performed.
- [`cli.patch`](cli.patch): the local CLI changes at commit `75c6385ca` used by the optimized benchmark harness.
- [`slim-services.patch`](slim-services.patch): the unreleased upstream service-image changes used to build the optimized benchmark artifacts.

The source campaigns contain complete methodology and raw logs. This folder includes only machine-readable snapshots needed to audit this report, with no runtime logs or credentials.

The preserved artifact patch includes a diagnostic dirty-submodule marker for `sources/pooler`; it is not a dependency update. Exclude that entry when applying the source changes (`git apply --exclude=sources/pooler slim-services.patch`). The actual listener-order fix is in `services/pooler/nix/startup-order.patch`.
