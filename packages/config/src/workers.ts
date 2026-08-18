import dedent from "dedent";
import { Effect, Schema } from "effect";

const tags = ["workers"];

const links = [
  {
    name: "`supabase workers` CLI subcommands",
    link: "https://supabase.com/docs/reference/cli/supabase-workers",
  },
];

/**
 * Worker names end up in hostnames, so they are DNS labels — the same pattern
 * the Management API validates `:name` against
 * (`v2/projects/{ref}/workers/{name}`). `root` is excluded from the key pattern
 * because `[workers]` carries both the project-wide `root` scalar and one
 * sub-table per worker; without the exclusion the record's index signature also
 * claims `root` and rejects its string value.
 */
const workerName = Schema.String.check(
  Schema.isPattern(/^(?!root$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
);

const worker = Schema.Struct({
  runtime: Schema.optionalKey(
    Schema.String.annotate({
      description: dedent`
        Runtime the worker is built on: \`dockerfile\` to build the directory's own
        Dockerfile, or one of the catalog runtimes (\`node\`, \`bun\`, \`deno\`,
        \`python\`, \`sandbox\`). Guessed from marker files when unset.
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
  source: Schema.optionalKey(
    Schema.String.annotate({
      description: dedent`
        Directory holding the worker's code, relative to the project root, when it
        does not live at \`supabase/<workers root>/<name>/\`.
      `,
      examples: ["packages/api"],
      tags,
      links,
    }),
  ),
});

/**
 * `[workers]` — a project-wide `root` plus one `[workers.<name>]` table per
 * worker, mirroring the `[functions.<slug>]` convention in the same file.
 *
 * `root` names the directory workers are grouped in, relative to `supabase/`;
 * a single worker whose code lives somewhere else entirely uses its own
 * `source` instead, which is anchored to the project root and so can leave
 * `supabase/`.
 */
export const workers = Schema.StructWithRest(
  Schema.Struct({
    root: Schema.optionalKey(
      Schema.String.annotate({
        description: dedent`
          Directory workers are grouped in, relative to \`supabase/\`. Defaults to
          \`workers\`.
        `,
        examples: ["services"],
        tags,
        links,
      }),
    ),
  }),
  [Schema.Record(workerName, worker)],
)
  .annotate({
    default: {},
    description: "Worker-specific configuration keyed by worker name.",
    tags,
  })
  .pipe(Schema.withDecodingDefault(Effect.succeed({})));
