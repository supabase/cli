import { inspectInt, inspectText, type InspectQuerySpec } from "../inspect-query.ts";
import { INTERNAL_SCHEMAS, likeEscapeSchema } from "../inspect-schemas.ts";

const SQL = `
SELECT
  FORMAT('%I.%I', n.nspname, c.relname) AS name,
  age(c.relfrozenxid)                   AS xid_age,
  2000000000 - age(c.relfrozenxid)      AS transactions_remaining
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND NOT n.nspname LIKE ANY($1)
ORDER BY age(c.relfrozenxid) DESC`;

export const xidAgeSpec: InspectQuerySpec = {
  name: "xid-age",
  sql: SQL,
  params: () => [likeEscapeSchema(INTERNAL_SCHEMAS)],
  headers: ["Table", "XID Age", "Transactions Remaining"],
  project: (row) => [
    inspectText(row["name"]),
    inspectInt(row["xid_age"]),
    inspectInt(row["transactions_remaining"]),
  ],
};
