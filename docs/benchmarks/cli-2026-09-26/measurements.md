# CLI benchmark measurements

## Collection and interpretation

The combined campaign contains 75 observed samples across 15 groups: 60 from the new-only run, 10 from the legacy stack run, and 5 reused legacy schema samples. Smoke measurements and canceled runs are excluded.

Readiness in default mode means the database is ready; eager modes wait for selected services. Linux runners are heterogeneous, so measurements across runs are descriptive and do not establish a causal regression comparison.

Native RSS is host RSS. Docker RSS adds host and container process RSS per sample and can double count shared pages. Payload sizes are registry-metadata estimates of compressed payload, not wire bytes. CPU utilization and peak RSS were not collected.

## Stack startup

Startup and preparation times are seconds, shown as median (min–max; sample count). Schema command durations are milliseconds. RSS and compressed payload are MiB.

| Implementation | Runtime | Mode         | Platform    |   n |         Cold ready (s) |      Cached ready (s) | Cached retained restart (s) | Idle RSS (MiB) |       Preparation (s) | Compressed payload (MiB) |
| -------------- | ------- | ------------ | ----------- | --: | ---------------------: | --------------------: | --------------------------: | -------------: | --------------------: | -----------------------: |
| legacy         | docker  | default      | linux-x64   | 5/5 | 92.3 (90.7–110.7; n=5) | 38.0 (37.7–38.4; n=5) |       32.5 (26.5–32.8; n=5) |    2623.5; n=5 | 54.7 (53.6–63.2; n=5) |          1905.0 MiB; n=5 |
| legacy         | docker  | eager-pooler | linux-x64   | 5/5 | 98.6 (97.8–117.3; n=5) | 37.5 (36.8–37.7; n=5) |       32.0 (26.3–32.9; n=5) |    3336.4; n=5 | 60.9 (59.3–72.7; n=5) |          2209.2 MiB; n=5 |
| new            | docker  | default      | linux-x64   | 5/5 |  17.0 (15.2–21.8; n=5) |    5.0 (3.0–5.3; n=5) |          2.1 (1.5–2.6; n=5) |     293.7; n=5 | 39.1 (31.2–50.8; n=5) |           591.5 MiB; n=5 |
| new            | docker  | eager        | linux-x64   | 5/5 |  30.8 (29.2–33.0; n=5) | 17.2 (14.1–18.6; n=5) |       11.5 (10.0–12.7; n=5) |    2902.1; n=5 | 38.2 (28.3–52.0; n=5) |           591.5 MiB; n=5 |
| new            | docker  | eager-pooler | linux-x64   | 5/5 |  33.1 (30.4–36.5; n=5) | 17.7 (16.4–20.1; n=5) |       12.3 (10.5–14.0; n=5) |    3227.3; n=5 | 33.4 (31.7–47.9; n=5) |           627.3 MiB; n=5 |
| new            | native  | default      | linux-x64   | 5/5 |  17.1 (16.7–17.2; n=5) |    3.9 (3.9–4.0; n=5) |          1.6 (1.5–1.7; n=5) |     294.6; n=5 | 29.9 (25.4–35.1; n=5) |           383.0 MiB; n=5 |
| new            | native  | default      | macos-arm64 | 5/5 |  27.2 (21.4–29.0; n=5) |    6.9 (5.6–9.4; n=5) |          1.7 (1.4–1.9; n=5) |     286.6; n=5 | 42.6 (33.7–49.6; n=5) |           402.3 MiB; n=5 |
| new            | native  | eager        | linux-x64   | 5/5 |  27.9 (24.8–28.4; n=5) | 13.1 (11.4–16.0; n=5) |         8.5 (7.5–11.2; n=5) |    2886.8; n=5 | 26.2 (24.4–29.9; n=5) |           383.0 MiB; n=5 |
| new            | native  | eager        | macos-arm64 | 5/5 |  46.3 (34.3–53.2; n=5) | 23.5 (19.3–35.4; n=5) |       14.6 (10.2–16.0; n=5) |    2484.9; n=5 | 42.9 (34.2–50.6; n=5) |           402.3 MiB; n=5 |
| new            | native  | eager-pooler | linux-x64   | 5/5 |  29.4 (26.5–29.8; n=5) | 16.8 (15.0–17.8; n=5) |       11.7 (10.9–12.0; n=5) |    3201.2; n=5 | 37.5 (28.2–40.4; n=5) |           411.5 MiB; n=5 |
| new            | native  | eager-pooler | macos-arm64 | 5/5 |  40.4 (30.9–46.9; n=5) | 21.1 (15.6–27.2; n=5) |        13.4 (9.7–17.5; n=5) |    2347.6; n=5 | 43.9 (35.6–47.1; n=5) |           425.8 MiB; n=5 |

## Schema command measurements

Times are milliseconds, shown as median (min–max; successful sample count).

| Implementation | Runtime | Platform                                     | CLI             | Command                                      |            Duration (ms) | Result                   |
| -------------- | ------- | -------------------------------------------- | --------------- | -------------------------------------------- | -----------------------: | ------------------------ |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `add_column.generate-and-apply`              |    5129 (4777–5391; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `add_table.generate-and-apply`               |    5035 (4834–5585; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.db-diff.apply-reset`                  |    5094 (4230–5427; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.db-diff.changed`                      |    3027 (2725–3874; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.db-diff.no-change.first`              |    3175 (2823–3675; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.db-diff.no-change.repeat`             |    3081 (2770–3928; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.declarative.no-change.first`          |    5686 (4885–5696; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.declarative.no-change.no-cache`       |  11614 (9298–12253; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.declarative.no-change.repeat`         |    5696 (4980–7233; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.reset-with-seed`                      |    5132 (4235–5634; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large_schema_small_edit.generate-and-apply` |    5481 (5131–6079; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `related_index_fk_rls.generate-and-apply`    |    5184 (4728–5436; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.db-diff.apply-reset`                  |    4839 (4178–5234; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.db-diff.changed`                      |    2877 (2526–3072; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.db-diff.no-change.first`              |    2774 (2574–3029; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.db-diff.no-change.repeat`             |    2827 (2623–3974; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.declarative.no-change.first`          |   9310 (8432–10898; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.declarative.no-change.no-cache`       |  10922 (8891–11968; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.declarative.no-change.repeat`         |    5079 (4830–5335; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.reset-with-seed`                      |    4934 (3927–5433; n=5) | 5/5 successful; 0 failed |
| new            | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `view_function.generate-and-apply`           |    5237 (4625–5390; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `add_column.generate-and-apply`              |    2974 (2470–3077; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `add_table.generate-and-apply`               |    3024 (2321–3124; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.db-diff.apply-reset`                  |    3932 (3231–5525; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.db-diff.changed`                      |    2021 (1467–2074; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.db-diff.no-change.first`              |    1975 (1569–2077; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.db-diff.no-change.repeat`             |    1974 (1468–2026; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.declarative.no-change.first`          |    3326 (2425–3377; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.declarative.no-change.no-cache`       |    8145 (6289–8450; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.declarative.no-change.repeat`         |    3281 (2523–3432; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large.reset-with-seed`                      |    3976 (3276–6778; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `large_schema_small_edit.generate-and-apply` |    3425 (2472–3526; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `related_index_fk_rls.generate-and-apply`    |    3024 (2370–3125; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.db-diff.apply-reset`                  |    3779 (3071–7081; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.db-diff.changed`                      |    1820 (1420–1871; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.db-diff.no-change.first`              |    1770 (1318–1870; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.db-diff.no-change.repeat`             |    1820 (1419–1822; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.declarative.no-change.first`          |    5884 (4679–6094; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.declarative.no-change.no-cache`       |    7742 (6089–7944; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.declarative.no-change.repeat`         |    2922 (2322–3022; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `small.reset-with-seed`                      |    3778 (3174–5126; n=5) | 5/5 successful; 0 failed |
| new            | native  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 0.0.0-automated | `view_function.generate-and-apply`           |    2977 (2371–3078; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `add_column.generate-and-apply`              |    4046 (3817–4912; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `add_table.generate-and-apply`               |    4504 (3105–4650; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `large.db-diff.apply-reset`                  |    8033 (5754–8567; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `large.db-diff.changed`                      |    2645 (2376–2801; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `large.db-diff.no-change.first`              |    2785 (2589–3141; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `large.db-diff.no-change.repeat`             |    2601 (2138–3271; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `large.declarative.no-change.first`          |    5383 (4157–6291; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `large.declarative.no-change.no-cache`       | 16547 (14877–18055; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `large.declarative.no-change.repeat`         |    5360 (4808–5579; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `large.reset-with-seed`                      |    7954 (5745–8580; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `large_schema_small_edit.generate-and-apply` |    4692 (3410–5534; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `related_index_fk_rls.generate-and-apply`    |    4104 (3825–4739; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `small.db-diff.apply-reset`                  |    7789 (5841–9159; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `small.db-diff.changed`                      |    2593 (2079–3245; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `small.db-diff.no-change.first`              |    2433 (1816–3014; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `small.db-diff.no-change.repeat`             |    2330 (2227–2964; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `small.declarative.no-change.first`          |  11623 (8902–12270; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `small.declarative.no-change.no-cache`       | 16158 (11773–17871; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `small.declarative.no-change.repeat`         |    4556 (3375–5198; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `small.reset-with-seed`                      |    7609 (6279–9143; n=5) | 5/5 successful; 0 failed |
| new            | native  | macOS-15.7.9-arm64-arm-64bit-Mach-O          | 0.0.0-automated | `view_function.generate-and-apply`           |    4305 (3316–4531; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `add_column.apply`                           |       566 (466–570; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `add_column.generate`                        |    7236 (5776–7535; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `add_table.apply`                            |       568 (465–617; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `add_table.generate`                         |    7285 (5728–7386; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `large.db-diff.apply-reset`                  | 17260 (16050–17463; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `large.db-diff.changed`                      |    8335 (6835–8492; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `large.db-diff.no-change.first`              |    8437 (6833–8540; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `large.db-diff.no-change.repeat`             |    8336 (6729–8438; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `large.declarative.no-change.first`          |   9993 (9384–10302; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `large.declarative.no-change.repeat`         |    8638 (7231–8990; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `large.reset-with-seed`                      | 17256 (16154–17364; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `large_schema_small_edit.apply`              |       566 (465–570; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `large_schema_small_edit.generate`           |    8487 (6982–8736; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `related_index_fk_rls.apply`                 |       566 (515–567; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `related_index_fk_rls.generate`              |    7282 (5830–7338; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `small.db-diff.apply-reset`                  | 17156 (15901–17317; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `small.db-diff.changed`                      |    7233 (5777–7487; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `small.db-diff.no-change.first`              |    7233 (6032–7389; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `small.db-diff.no-change.repeat`             |    7136 (5983–7333; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `small.declarative.no-change.first`          | 24132 (23778–24870; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `small.declarative.no-change.repeat`         |    7438 (5827–7539; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `small.reset-with-seed`                      | 17107 (16102–17215; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `view_function.apply`                        |       567 (465–616; n=5) | 5/5 successful; 0 failed |
| legacy         | docker  | Linux-6.8.0-1064-azure-x86_64-with-glibc2.35 | 2.117.0         | `view_function.generate`                     |    7236 (5829–7333; n=5) | 5/5 successful; 0 failed |

## Completeness and failures

- new / docker / default: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- new / docker / eager: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- new / docker / eager-pooler: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- new / native / default: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- new / native / default: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- new / native / eager: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- new / native / eager: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- new / native / eager-pooler: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- new / native / eager-pooler: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- legacy / docker / default: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- legacy / docker / eager-pooler: 5/5 samples (complete); statuses {"completed": 5}; failed measurements 0.
- new / docker / Linux-6.8.0-1064-azure-x86_64-with-glibc2.35: 5/5 samples (complete); statuses {"success": 5}; failed measurements 0.
- new / native / Linux-6.8.0-1064-azure-x86_64-with-glibc2.35: 5/5 samples (complete); statuses {"success": 5}; failed measurements 0.
- new / native / macOS-15.7.9-arm64-arm-64bit-Mach-O: 5/5 samples (complete); statuses {"success": 5}; failed measurements 0.
- legacy / docker / Linux-6.8.0-1064-azure-x86_64-with-glibc2.35: 5/5 samples (complete); statuses {"success": 5}; failed measurements 0.

## Native artifact cache digest consistency

Compared metadata SHA-256 by service and platform across 30/30 new native samples: 24 service/platform combinations; complete: True; consistent: True; mismatches: 0; missing digests: 0; unreadable raw files: 0.

## Provenance

- new: [GitHub Actions run 36269764438](https://github.com/supabase/cli/actions/runs/36269764438); workflow head `2b0c5870d76336d5dd47d3731dc039f560c87a67`, source `2c75f9749ec521d6798ec847ed83380b4cf1a0bd`; input `/Users/jgoux/.codex/benchmarks/pr6831-2026-09-26/full-36269764438/summary.json`.
- legacy: [GitHub Actions run 36070185401](https://github.com/supabase/cli/actions/runs/36070185401); workflow head `2b0c5870d76336d5dd47d3731dc039f560c87a67`, source `4cebcf8779ef8ba983f38632eb4c48a86c5e829e`; input `/Users/jgoux/.codex/benchmarks/develop-4cebcf8-2026-09-25/legacy-36070185401/summary.json`.
- reused legacy schema: [GitHub Actions run 36057580204](https://github.com/supabase/cli/actions/runs/36057580204); workflow head `950c8bdf94faddfdc8fc432a5c42a1592451de82`, source `5a3e195ad199fb18d6d106525203c8e67710b45a`; input `/Users/jgoux/.codex/benchmarks/pr6809-2026-09-24/full-36057580204/summary.json`.
