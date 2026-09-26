# Benchmark notes

These notes describe the sources, measurement boundaries, and limits for the [stack report](stack/README.md) and [schema report](schema/README.md).

**Benchmark results · September 26, 2026 · PR 6831**

## Campaign and source runs

The report combines 15 observed groups and 75 samples: 60 new CLI samples, 10 legacy stack samples, and 5 reused legacy schema samples. Expected coverage is 15 groups × 5 samples. 0 missing or incomplete group entries are recorded.

| Measurement source   |                                                            Workflow run | Workflow head                              | Workflow build/source SHA                  |
| -------------------- | ----------------------------------------------------------------------: | ------------------------------------------ | ------------------------------------------ |
| new                  | [36269764438](https://github.com/supabase/cli/actions/runs/36269764438) | `2b0c5870d76336d5dd47d3731dc039f560c87a67` | `2c75f9749ec521d6798ec847ed83380b4cf1a0bd` |
| legacy               | [36070185401](https://github.com/supabase/cli/actions/runs/36070185401) | `2b0c5870d76336d5dd47d3731dc039f560c87a67` | `4cebcf8779ef8ba983f38632eb4c48a86c5e829e` |
| reused legacy schema | [36057580204](https://github.com/supabase/cli/actions/runs/36057580204) | `950c8bdf94faddfdc8fc432a5c42a1592451de82` | `5a3e195ad199fb18d6d106525203c8e67710b45a` |

The new CLI source is [`2c75f9749ec521d6798ec847ed83380b4cf1a0bd`](https://github.com/supabase/cli/commit/2c75f9749ec521d6798ec847ed83380b4cf1a0bd); harness/workflow head `2b0c5870d76336d5dd47d3731dc039f560c87a67`. For legacy rows, this SHA identifies workflow build/source provenance; the measured executable remains CLI 2.117.0. Each included group's raw provenance is retained in [report-data.json](../report-data.json).

## Stack startup measurements

New default readiness ends when the database is ready, while other enabled services can prepare in the background. Eager modes wait for selected services. In these measurements, new eager selects 11 services while legacy default starts 12 containers. Legacy readiness waits for its full configured stack. Service sets, versions, and architecture differ; readiness times do not represent equal work.

Preparation is a separate timer and must not be added to cold startup. Legacy image-pull replay is not the CLI scheduler. macOS has new native measurements only; there is no legacy macOS or Docker comparison. Linux comparisons reuse a separately collected legacy baseline, so heterogeneous runner CPUs prevent causal attribution.

## Schema measurements and correctness

Schema measurements use database-only environments. Declarative scenario cycle times include the harness-recorded generate/apply operations; legacy generation and application can be separate commands. Command completion and semantic validation are recorded separately. A successful command exit alone is not proof that the expected catalog state, no-change behavior, seed state, or reset state is correct. The summarizer's `unverified` category can include commands that exited zero without a corresponding semantic assertion; it is distinct from a failed assertion.

## Memory and payload

Native RSS reports host process RSS. Docker RSS adds host RSS and container process RSS for each sample; shared pages may be counted twice, so the sum is not physical memory. RSS is sampled in idle windows, not continuously. CPU utilization and peak RSS were not collected for stack startup.

Compressed payload estimates are derived from artifact and image metadata, not wire transfer measurements. Registry metadata does not measure retries, protocol overhead, or actual bytes transferred.

## Coverage and failures

The report-data builder found no missing or incomplete expected groups.
Recorded failures: 0 stack phase attempts, 0 schema command attempts, 0 declarative cycles, and 0 semantic checks. Per-group attempt counts and failure details are in [report-data.json](../report-data.json).
No missing groups or failures were recorded in these inputs.

Native cached artifact metadata digest check: 30/30 samples observed; 24 service/platform pairs; consistent=true; mismatches=0; missing digest metadata=0.

## Data and audit

The [measurement tables](../measurements.md) provide the aggregate view. The [report dataset](../report-data.json) contains group-level metrics and provenance; the [audit](../audit.json) records raw status, readiness, cleanup, and image identity checks. Chart assets are under [stack/assets](stack/assets/) and [schema/assets](schema/assets/).
