import dedent from "dedent";
import { Effect, Schema } from "effect";

const tags = ["compute"];

// Compute names end up in hostnames, so they must be valid DNS labels, matching the
// Management API's own validation.
const computeName = Schema.String.check(Schema.isPattern(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/));

const computeEntry = Schema.Struct({
  runtime: Schema.optionalKey(
    Schema.String.annotate({
      description: dedent`
        Runtime the compute is built on: \`dockerfile\` to build the directory's own
        Dockerfile, or one of the catalog runtimes (\`node\`, \`deno\`). Guessed from
        marker files when unset.
      `,
      examples: ["node"],
      tags,
    }),
  ),
  size: Schema.optionalKey(
    Schema.String.annotate({
      description: dedent`
        Instance size, denominated by memory. Each size implies its own vCPU count,
        so it is the one dial rather than two.
      `,
      examples: ["2gb"],
      tags,
    }),
  ),
  exposure: Schema.optionalKey(
    // Left as an unconstrained string, matching the Management API: constraining it
    // here would reject values a newer CLI understands.
    Schema.String.annotate({
      description: dedent`
        How the compute is reached: \`public\` gives it an internet-facing URL,
        \`private\` keeps it reachable only from inside the project. Every deploy
        sends a complete spec, so the value recorded here is what keeps a private
        compute private; \`--exposure\` overrides it for one deploy. Defaults to
        \`public\`.
      `,
      examples: ["private"],
      tags,
    }),
  ),
  instances: Schema.optionalKey(
    // Bounded to match the Management API's input schema; an out-of-range value would
    // be dropped rather than sent, deploying a different count than the config asked for.
    Schema.Number.check(
      Schema.isInt().annotate({ expected: "a whole number of instances" }),
      Schema.isGreaterThanOrEqualTo(0).annotate({ expected: "zero or more instances" }),
    ).annotate({
      description: dedent`
        Number of instances to run. Every deploy sends a complete spec, so a count
        recorded here is what keeps a scaled compute scaled; \`--instances\` overrides
        it for one deploy. Defaults to 1.
      `,
      examples: [3],
      tags,
    }),
  ),
  source: Schema.optionalKey(
    Schema.String.annotate({
      description: dedent`
        Directory holding the compute's code, relative to the project root, when it
        does not live at \`supabase/compute/<name>/\`.
      `,
      examples: ["packages/api"],
      tags,
    }),
  ),
});

/**
 * `[compute]` — one `[compute.<name>]` table per Compute service, keyed by name, plus
 * room for settings that apply to every compute.
 *
 * A struct-with-rest rather than a bare `Record` so both can share the one table: a
 * `Record` has no slot for a sibling scalar, so `[compute] source = "./my-apps"` would
 * be read as a compute *named* `source` and rejected as a non-table. There are no such
 * settings yet. Adding the first one is a field in the struct below and nothing else —
 * `[compute.<name>]` does not move — at the cost of that name no longer being available
 * to a compute, which is why they are added deliberately rather than speculatively.
 */
export const compute = Schema.StructWithRest(Schema.Struct({}), [
  Schema.Record(computeName, computeEntry),
])
  .annotate({
    default: {},
    description: "Compute-specific configuration keyed by compute name.",
    tags,
  })
  .pipe(Schema.withDecodingDefault(Effect.succeed({})));
