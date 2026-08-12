# Schema Workflow Glossary

This glossary defines the terms used while designing the alpha database workflow. It
distinguishes user intent from generated artifacts and live state.

| Term                        | Meaning                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared schema intent      | The user-authored SQL files that describe the desired managed database shape.                                                                            |
| Local schema representation | The declared schema intent plus the metadata needed to interpret it consistently, such as management scope and profile.                                  |
| Managed database shape      | The subset of PostgreSQL objects owned by the workflow after applying the selected pg-delta profile, baseline, and scope.                                |
| Schema compiler             | pg-delta's role: turn observed and desired managed database shapes into a plan or export. It does not own the project's migration ledger.                |
| Plan                        | A versioned pg-delta artifact containing ordered actions, fingerprints, transaction boundaries, rename decisions, and safety metadata.                   |
| Generated migration         | One or more concrete SQL migration files rendered from a plan and named for the project's migration runner.                                              |
| Migration ledger            | The ordered record of concrete migrations known to the project and recorded as applied by a target database.                                             |
| Schema checkpoint           | A possible durable record tying declared schema intent to the migration ledger and observed database fingerprint. Whether alpha needs this is undecided. |
| Shadow database             | A disposable PostgreSQL database or isolated cluster used to load declared SQL so pg-delta can observe the desired state.                                |
| Baseline                    | A pg-delta snapshot subtracted from both sides to keep platform-provided objects outside the managed shape.                                              |
| Profile                     | pg-delta policy and integration configuration defining managed objects, assumed platform state, handlers, redaction, and an optional baseline.           |
| Database scope              | Management of objects local to one database; cluster-global role creation and membership are excluded.                                                   |
| Cluster scope               | Management that includes cluster-global objects and therefore requires a genuinely isolated shadow cluster.                                              |
| Drift                       | A difference between an expected managed state and an observed live target that is not represented by the intended workflow transition.                  |
| Generate                    | Compile declared schema intent into migration files without mutating a live target.                                                                      |
| Apply                       | Mutate the local database and record the concrete migration execution consistently.                                                                      |
| Push                        | Synchronize local intent to a platform target. It is never shorthand for local mutation.                                                                 |
| Pull                        | Export platform state into the local schema representation. It does not mutate the local database.                                                       |
| Destructive change          | A planned action that drops an object or that pg-delta marks as destructive data loss.                                                                   |
| Rewrite risk                | A planned action that may rewrite table data even when it is not classified as destructive.                                                              |
| Unmodeled object            | User-created PostgreSQL state detected by pg-delta but not represented by its fact model.                                                                |
