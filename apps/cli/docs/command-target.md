# Command target

Every command that acts on a database or hosted project announces the target it resolved, once, before it acts. The same identity goes to machine consumers as the JSON `target` object.

## Banner

`Target: <text>` on stderr in every output format, printed once per distinct text.

| Target                                | Text                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Local stack                           | `local stack (<host>:<port>)`                                                       |
| Local stack, nothing selected, linked | `local stack (<host>:<port>) · default; pass --linked for <name> (<ref>)`           |
| `--db-url`                            | `custom Postgres (<host>:<port>)`; the connection string's credentials never appear |
| Linked project the cache names        | `project <name> (<ref>) · production`                                               |
| Linked project nothing vouches for    | `project <ref>`, or `project <name> (<ref>)` when the project picker named it       |
| Ref other than the linked project     | `project <ref> (not the linked project)`                                            |
| Branch found by name or UUID          | `project <parent ref> · branch <name> (<ref>)`, or `branch <ref>` for a UUID        |

The `default; pass --linked` hint appears only when the checkout is linked and neither a selector flag nor a workspace `target` chose local. "Branch" is claimed only on positive evidence: a branch lookup by name or UUID, or a live probe. A cached link never proves one.

## JSON `target`

`json` and `stream-json` results carry `target`, tagged by `kind`:

| `kind`   | Fields                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`  | `host`, `port`                                                                                                                                            |
| `db-url` | `host`, `port`                                                                                                                                            |
| `linked` | `project_ref`, `environment` (`production`, `branch` or `unverified`), optional `project_name`, optional `parent_project_ref` (a branch's parent project) |

`environment` is `production` when the linked-project cache names the resolved ref, `branch` on positive evidence, and `unverified` otherwise. A failed identity check is `unverified`, never `branch`.

The first announced target becomes the run's `target`. It is merged into object results and into the machine error envelope. Array results are written unchanged. A command that owns extra `target` fields (for example `branch`, `local_scope`, or `config push`'s probed `environment`) adds them in front of the announced identity's, and its own values win on a clash.

The schema is `CommandTargetJson` in `src/shared/output/command-target.service.ts`; every target is encoded through it before it reaches output.
