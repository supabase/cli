import dedent from "dedent";
import { Effect, Schema } from "effect";

const tags = ["workers"];

const links = [
  {
    name: "`supabase experimental workers` CLI subcommands",
    link: "https://supabase.com/docs/reference/cli/supabase-workers",
  },
];

/**
 * Worker names end up in hostnames, so they are DNS labels — the same pattern
 * the Management API validates `:name` against
 * (`v2/projects/{ref}/workers/{name}`).
 */
const workerName = Schema.String.check(Schema.isPattern(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/));

const worker = Schema.Struct({
  runtime: Schema.optionalKey(
    Schema.String.annotate({
      description: dedent`
        Runtime the worker is built on: \`dockerfile\` to build the directory's own
        Dockerfile, or one of the catalog runtimes (\`node\`, \`deno\`). Guessed from
        marker files when unset.
      `,
      examples: ["node"],
      tags,
      links,
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
      links,
    }),
  ),
  instances: Schema.optionalKey(
    // Bounded to match `spec.instances` in the Management API's input schema. A
    // value that gets past here is dropped rather than sent, so leaving it
    // unbounded deploys a different count than the config asked for.
    Schema.Number.check(
      Schema.isInt().annotate({ expected: "a whole number of instances" }),
      Schema.isGreaterThanOrEqualTo(0).annotate({ expected: "zero or more instances" }),
    ).annotate({
      description: dedent`
        Number of instances to run. Every deploy sends a complete spec, so a count
        recorded here is what keeps a scaled worker scaled; \`--instances\` overrides
        it for one deploy. Defaults to 1.
      `,
      examples: [3],
      tags,
      links,
    }),
  ),
  source: Schema.optionalKey(
    Schema.String.annotate({
      description: dedent`
        Directory holding the worker's code, relative to the project root, when it
        does not live at \`supabase/workers/<name>/\`.
      `,
      examples: ["packages/api"],
      tags,
      links,
    }),
  ),
});

/**
 * `[workers]` — one `[workers.<name>]` table per worker, mirroring the
 * `[functions.<slug>]` convention in the same file.
 *
 * Workers live at `supabase/workers/<name>/`; one whose code lives somewhere
 * else entirely uses its own `source`, which is anchored to the project root and
 * so can leave `supabase/`.
 */
export const workers = Schema.Record(workerName, worker)
  .annotate({
    default: {},
    description: "Worker-specific configuration keyed by worker name.",
    tags,
  })
  .pipe(Schema.withDecodingDefault(Effect.succeed({})));
