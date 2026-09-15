import dedent from "dedent";
import { Effect, Schema } from "effect";

const tags = ["compute"];

/**
 * Settings that apply to every compute rather than to one. Empty today.
 *
 * A key belongs here only when it cannot be expressed as a default: when setting it is not
 * equivalent to writing the same key and value into every `[compute.<name>]` table that
 * omits it. Anything expressible as one belongs in `[compute.defaults]`, nested rather than
 * sharing the namespace with compute names, so it costs no reserved word.
 *
 * Exported so the schema's declared keys can be checked against this list, since going
 * through here is what reserves a name.
 */
export const rootFields = {};

// Reserved before the settings using them exist, so introducing one later does not break a
// project that had already named a compute after it.
const forwardReserved = ["defaults"];

/** Names a compute may not take, because `[compute]` uses them for itself. */
export const RESERVED_COMPUTE_NAMES: ReadonlyArray<string> = [
  ...Object.keys(rootFields),
  ...forwardReserved,
];

// Compute names end up in hostnames, so they must be valid DNS labels, matching the
// Management API's own validation. Reserved names are excluded by the same pattern rather
// than a separate filter, so the generated JSON Schema carries the exclusion too — a filter
// is not expressible there, which would let an editor accept a key the CLI drops.
const computeName = Schema.String.check(
  Schema.isPattern(
    new RegExp(`^(?!(?:${RESERVED_COMPUTE_NAMES.join("|")})$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`),
  ),
);

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
 * `[compute]` — one `[compute.<name>]` table per Compute service, keyed by name, alongside
 * the settings in {@link rootFields} that apply to every compute.
 *
 * A struct-with-rest rather than a bare `Record` so both can share the one table: a `Record`
 * has no slot for a sibling key, so a setting would be read as a compute *named* after it.
 * Adding one is a field in {@link rootFields} and nothing else — `[compute.<name>]` does not
 * move, and the name is reserved automatically.
 */
export const compute = Schema.StructWithRest(Schema.Struct(rootFields), [
  Schema.Record(computeName, computeEntry),
])
  .annotate({
    default: {},
    description: "Compute-specific configuration keyed by compute name.",
    tags,
  })
  .pipe(Schema.withDecodingDefault(Effect.succeed({})));
