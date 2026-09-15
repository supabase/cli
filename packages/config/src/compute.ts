import dedent from "dedent";
import { Effect, Schema } from "effect";

const tags = ["compute"];

/**
 * Settings that apply to every compute rather than to one. Empty today.
 *
 * A key belongs here only when it cannot be expressed as a default — when setting it is
 * *not* equivalent to writing the same key and value into every `[compute.<name>]` table
 * that omits it. A base directory is the motivating example: the root value is combined
 * with each compute's name to derive a different path per compute, so it is a rule for
 * producing values rather than a value, and substituting it into each entry would point
 * every compute at one directory.
 *
 * Anything expressible as a default belongs in `[compute.defaults]` instead, where it
 * costs nothing because it is nested rather than sharing the namespace with compute names.
 * A key here costs a reserved word, so the bar is deliberately high.
 *
 * Exported so the schema's declared keys can be checked against this list: going through
 * here is what reserves a name, so a setting declared any other way has to be caught.
 */
export const rootFields = {};

/**
 * Names reserved before the settings that will use them exist, so introducing one later is
 * not a breaking change for a project that had already named a compute after it.
 */
const forwardReserved = ["defaults"];

/**
 * Names a compute may not take, because `[compute]` uses them for itself.
 *
 * Reserving a word is what makes a non-table setting possible at all. Every key under
 * `[compute]` is checked against the rest record below, fixed keys included, so a scalar
 * would otherwise have to satisfy the per-compute entry schema and no value could. Removing
 * the word from the key schema takes it out of that check, leaving only the field's own type
 * to apply.
 */
export const RESERVED_COMPUTE_NAMES: ReadonlyArray<string> = [
  ...Object.keys(rootFields),
  ...forwardReserved,
];

// Compute names end up in hostnames, so they must be valid DNS labels, matching the
// Management API's own validation.
const computeName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
  Schema.makeFilter((name: string) =>
    RESERVED_COMPUTE_NAMES.includes(name)
      ? `"${name}" is reserved by the [compute] section and cannot name a compute`
      : undefined,
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
