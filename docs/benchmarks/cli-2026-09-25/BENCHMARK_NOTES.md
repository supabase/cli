# Benchmark notes

These notes provide shared methodology and ranges for the [stack report](stack/README.md) and [schema report](schema/README.md). Medians are the default summary; tables below preserve the observed min–max across five samples.

## Samples and workflow sources

The campaign has 15 groups × 5 samples: 60 new CLI samples (45 stack and 15 schema), 10 fresh legacy stack samples, and five reused legacy schema samples. Smoke attempts are excluded. All included stack starts and schema commands completed successfully. Schema checks verified generated objects, apply state, seed rows, and reset state.

The new CLI source is [`4cebcf8779ef8ba983f38632eb4c48a86c5e829e`](https://github.com/supabase/cli/commit/4cebcf8779ef8ba983f38632eb4c48a86c5e829e). Sources: [new CLI workflow run 36069768900](https://github.com/supabase/cli/actions/runs/36069768900), [legacy stack run 36070185401](https://github.com/supabase/cli/actions/runs/36070185401), and [reused legacy schema run 36057580204](https://github.com/supabase/cli/actions/runs/36057580204).

## Stack startup samples

The experimental stack was enabled through `[experimental] stack = true`. New Docker runs passed `--runtime docker`; eager runs added `--eager`. Legacy CLI 2.117.0 has only Docker measurements. Linux comparisons use the legacy Linux Docker group for both new Docker and new native; this does not imply a legacy native measurement. macOS has new native results only. Hosted Linux CPU models varied across runs, so cross-runner comparisons cannot establish causal attribution.

Each group reports median (min–max). Durations are seconds; memory is idle RSS in MiB; compressed payload is decimal MB. The table below is generated from the supplied aggregate data.

| Platform · implementation · mode  | Runtime |        Cached ready |           Cold ready |    Retained restart |         Preparation |                  Idle RSS | Compressed payload |
| --------------------------------- | ------- | ------------------: | -------------------: | ------------------: | ------------------: | ------------------------: | -----------------: |
| Linux x64 · new default           | docker  | 12.68 (12.53–12.78) |  25.45 (24.12–27.73) |    2.31 (2.03–2.38) | 30.91 (27.54–43.91) |    296.05 (295.38–297.08) |           620.3 MB |
| Linux x64 · new eager             | docker  | 25.27 (24.99–26.45) |  36.91 (35.97–37.41) | 12.23 (11.87–12.46) | 29.27 (28.35–47.08) | 2910.04 (2893.75–2912.41) |           620.3 MB |
| Linux x64 · new eager + pooler    | docker  | 27.09 (15.95–27.27) |  42.13 (30.70–43.27) |  13.59 (7.77–14.20) | 46.76 (30.86–49.02) | 3215.15 (3199.09–3224.60) |           657.8 MB |
| Linux x64 · new default           | native  |  10.39 (8.77–10.60) |  23.44 (22.60–24.51) |    1.61 (1.36–1.79) | 31.55 (21.45–36.22) |    293.83 (290.29–294.41) |           401.6 MB |
| macOS arm64 · new default         | native  | 14.88 (12.40–16.47) |  35.16 (28.53–40.21) |    2.05 (1.63–2.43) | 44.40 (38.03–48.55) |    299.67 (290.98–305.72) |           421.8 MB |
| Linux x64 · new eager             | native  | 21.41 (19.99–21.63) |  35.65 (34.67–39.00) |  10.60 (9.65–10.94) | 23.43 (21.13–26.34) | 2890.34 (2876.84–2901.00) |           401.6 MB |
| macOS arm64 · new eager           | native  | 29.66 (26.63–33.94) |  52.63 (46.40–69.15) | 13.80 (11.53–15.52) | 45.88 (39.39–51.44) | 2187.70 (1986.08–2494.30) |           421.8 MB |
| Linux x64 · new eager + pooler    | native  | 22.05 (18.44–23.54) |  35.45 (35.17–37.72) |  11.18 (8.02–12.26) | 28.55 (26.59–30.25) | 3187.10 (3185.66–3197.96) |           431.5 MB |
| macOS arm64 · new eager + pooler  | native  | 23.27 (19.09–31.09) |  43.47 (34.11–48.58) |  10.89 (8.97–13.83) | 36.15 (28.86–44.36) | 2279.42 (2111.45–2479.48) |           446.4 MB |
| Linux x64 · legacy default        | docker  | 38.02 (37.73–38.44) | 92.34 (90.74–110.73) | 32.52 (26.51–32.81) | 54.67 (53.64–63.20) | 2623.48 (2589.50–2639.16) |          1997.6 MB |
| Linux x64 · legacy eager + pooler | docker  | 37.50 (36.75–37.71) | 98.57 (97.78–117.27) | 32.02 (26.27–32.87) | 60.91 (59.28–72.68) | 3336.39 (3296.75–3342.45) |          2316.5 MB |

The preparation timer is a separate experiment and must not be added to cold startup. Cold starts began with empty native artifact caches and Docker preflight image inventories. Legacy used the GHCR image mirror with matching image digests and recorded no throttling or retry markers. The legacy image-pull replay measures four concurrent pulls and is not the CLI scheduler.

New default starts only the database while preparing other enabled services in the background. Legacy default starts 12 containers. New eager starts 11 services and eager with pooler starts 12; legacy with pooler starts 13 containers. Service sets, versions, and architecture are not identical. Docker RSS adds host and container process RSS, so shared pages may be counted twice. These are idle window measurements, not peak or loaded memory. Stack CPU utilization and peak RSS were not sampled continuously.

## Schema command samples

New schema groups include Linux Docker, Linux native, and macOS native; legacy schema has a Linux Docker group only, reused from the earlier run. Each schema environment starts a database-only stack with non-database services excluded. The large fixture adds 100 tables to the small benchmark schema. Legacy exposes generation and application as separate commands; new declarative sync can generate and apply in one command.

Each duration below is median (min–max), seconds, across five samples. All table cells are generated from `report-data.json`.

| Operation                        |    New Docker · small |    New Docker · large |    New native · small |    New native · large |     New macOS · small |     New macOS · large | Legacy Docker · small | Legacy Docker · large |
| -------------------------------- | --------------------: | --------------------: | --------------------: | --------------------: | --------------------: | --------------------: | --------------------: | --------------------: |
| Changed DB diff                  |    2.88 (2.87–3.13) s |    3.03 (3.02–3.17) s |    1.78 (1.57–1.87) s |    1.97 (1.62–2.02) s |    2.60 (1.92–2.79) s |    2.71 (1.80–3.02) s |    7.23 (5.78–7.49) s |    8.33 (6.84–8.49) s |
| No-change DB diff · first        |    2.87 (2.78–3.29) s |    3.33 (3.03–3.48) s |    1.82 (1.57–1.87) s |    2.02 (1.62–2.03) s |    2.82 (2.27–2.99) s |    2.72 (2.34–3.40) s |    7.23 (6.03–7.39) s |    8.44 (6.83–8.54) s |
| No-change DB diff · repeat       |    2.98 (2.77–3.13) s |    3.03 (2.98–3.13) s |    1.77 (1.52–1.87) s |    1.97 (1.62–2.02) s |    2.53 (2.01–2.85) s |    2.66 (2.09–4.00) s |    7.14 (5.98–7.33) s |    8.34 (6.73–8.44) s |
| DB diff · apply and reset        | 12.55 (11.59–12.80) s | 12.51 (11.69–12.96) s |   9.74 (8.64–10.39) s |   9.89 (8.64–10.04) s | 15.12 (11.93–15.27) s | 14.37 (10.06–15.80) s | 17.16 (15.90–17.32) s | 17.26 (16.05–17.46) s |
| Declarative no-change · first    | 16.92 (16.36–17.23) s |    5.58 (5.44–5.65) s | 11.95 (10.39–12.45) s |    3.33 (2.72–3.38) s | 17.33 (14.35–20.28) s |    5.08 (3.48–5.81) s | 24.13 (23.78–24.87) s |   9.99 (9.38–10.30) s |
| Declarative no-change · repeat   |    5.14 (4.99–5.33) s |    5.64 (5.43–5.79) s |    2.97 (2.53–3.02) s |    3.32 (2.77–3.33) s |    4.23 (3.26–4.70) s |    5.36 (3.98–5.81) s |    7.44 (5.83–7.54) s |    8.64 (7.23–8.99) s |
| Declarative no-change · no cache | 25.99 (24.38–26.91) s | 26.44 (24.73–27.45) s | 19.82 (17.16–20.58) s | 20.22 (17.72–20.47) s | 27.20 (22.84–32.24) s | 31.74 (22.03–32.67) s |                     — |                     — |
| Reset with seed                  | 12.30 (11.44–12.81) s | 12.70 (11.80–12.91) s |    9.74 (8.53–9.79) s |   9.94 (8.83–10.49) s | 15.56 (11.35–17.10) s | 15.01 (10.52–16.30) s | 17.11 (16.10–17.21) s | 17.26 (16.15–17.36) s |

New generate-and-apply median durations range from 5.08–5.54 s on Linux Docker, 2.97–3.33 s on Linux native, and 4.58–4.81 s on macOS native. Legacy generate medians range from 7.24–8.49 s; apply medians are about 0.57 s. Compilation is excluded.

## Metric definitions and limits

Stack readiness in new default mode means the database is ready; eager waits for selected services, and legacy readiness waits for its full configured stack. Speed ratios are legacy duration divided by new duration and use unrounded values. The default comparison is a user-facing endpoint comparison, not equal service work.

Docker idle RSS combines host RSS and container process RSS; shared pages may be counted twice. Native RSS is total host process RSS. Stack memory was sampled during idle windows, not continuously. Stack CPU utilization and peak RSS were not captured. Schema command process-tree peak RSS was sampled every 250 ms and resource snapshots were recorded; those schema measurements are outside the selected comparisons.

Compressed payload estimates are derived from manifests, not measured wire bytes. Cold startup includes initialization, downloading, and extraction; it is not network transfer time alone. Five samples give a directional summary, especially where observed ranges are wide.

## Data and chart regeneration

The [report dataset](report-data.json) contains all summarized metrics and provenance. The [audit](audit.json) records the successful measurement checks; [registry verification](registry-verification.json) records legacy image digest equivalence. See [chart regeneration instructions](../../../tools/stack-benchmarks/README.md#integrated-cli-report-charts).
