import { Schema } from "effect";

const tags = ["local"];

const upstreamVersion = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const malformedRevision = /-r(?:0\d+)?$/u;
const orioledbMarker = /-orioledb(?:-|$)/u;

function versionIssue(key: string, version: string): string | undefined {
  if (version === "linked" || version === "bundled") {
    return undefined;
  }
  if (key === "default") {
    return `local.services.default.version "${version}" must be "linked" or "bundled"`;
  }
  if (version === "default" || !upstreamVersion.test(version) || malformedRevision.test(version)) {
    return `local.services.${key}.version "${version}" must be "linked", "bundled", or an upstream version optionally followed by -r<N> (N a non-negative integer without leading zeros)`;
  }
  if (orioledbMarker.test(version) && key !== "database") {
    return `local.services.${key}.version "${version}" uses the -orioledb marker, which is only valid for the database service`;
  }
  return undefined;
}

const sizeUnits: Readonly<Record<string, number>> = {
  "": 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
};
const sizePattern = /^(\d+(?:\.\d+)?) ?(?:([kmgtp])(?:i?b)?|b)?$/iu;

function sizeInBytes(text: string): number | undefined {
  const match = sizePattern.exec(text);
  const amount = match?.[1];
  return amount === undefined
    ? undefined
    : Math.trunc(Number(amount) * (sizeUnits[(match?.[2] ?? "").toLowerCase()] ?? 1));
}

/** The smallest limits Docker accepts. */
const minMemoryBytes = 6 * 1024 ** 2;
const minCpus = 0.01;

const memory = Schema.String.annotate({
  description:
    "Memory limit for the service container, as a size such as `512MiB` or `1GiB` (1024-based, case-insensitive; a bare number is bytes). At least `6MiB`; swap is disabled.",
  examples: ["512MiB", "1GiB"],
  tags,
}).check(
  Schema.isPattern(sizePattern, { message: "must be a size such as 512MiB or 1GiB" }),
  Schema.makeFilter((value: string) => {
    const bytes = sizeInBytes(value);
    return bytes === undefined || (bytes >= minMemoryBytes && Number.isSafeInteger(bytes))
      ? undefined
      : "must be at least 6MiB and less than 8PiB";
  }),
);

const cpus = Schema.Finite.annotate({
  description:
    "CPU limit for the service container, in CPUs; fractions down to `0.01` are allowed (for example `0.5`).",
  examples: [0.5, 1, 2],
  tags,
}).check(Schema.isGreaterThanOrEqualTo(minCpus, { message: "must be at least 0.01" }));

const container = Schema.Struct({
  memory: Schema.optionalKey(memory),
  cpus: Schema.optionalKey(cpus),
}).annotate({
  description:
    "Resource limits applied to the service container. Used only when the local stack runs in containers (Docker or Podman); the native runtime ignores this table.",
  tags,
});

const serviceEntry = Schema.Struct({
  version: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Version specifier: `linked` (the linked project's version), `bundled` (the version shipped with this CLI), or an upstream version optionally followed by `-r<N>`. A `-orioledb` version is only valid for `database`.",
      examples: ["bundled", "v2.197.0", "v1.30.2-r1", "17.6.1.200-orioledb"],
      tags,
    }),
  ),
  container: Schema.optionalKey(container),
});

const defaultEntry = Schema.Struct({
  version: Schema.String.annotate({
    description:
      "Version specifier for every service without its own entry: `linked` (the linked project's version) or `bundled` (the version shipped with this CLI).",
    examples: ["bundled", "linked"],
    tags,
  }),
});

const entry = Schema.optionalKey(serviceEntry);

const services = Schema.Struct({
  default: Schema.optionalKey(defaultEntry),
  database: entry,
  auth: entry,
  rest: entry,
  realtime: entry,
  storage: entry,
  imgproxy: entry,
  functions: entry,
  studio: entry,
  pgmeta: entry,
  mail: entry,
  analytics: entry,
  pooler: entry,
})
  .annotate({
    description:
      "Per-service settings for the local stack, keyed by service: version specifiers and container resource limits.",
    tags,
  })
  .check(
    Schema.makeFilter(
      (value: { readonly [key: string]: { readonly version?: string } | undefined }) => {
        for (const [key, entry] of Object.entries(value)) {
          const version = entry?.version;
          const issue = version === undefined ? undefined : versionIssue(key, version);
          if (issue !== undefined) {
            return { path: [key, "version"], issue };
          }
        }
        return undefined;
      },
    ),
  );

/** `[local]` — settings for the local stack only; hosted commands never read it. */
export const local = Schema.Struct({
  services: Schema.optionalKey(services),
}).annotate({
  description: "Local-stack-only settings; hosted commands never read this section.",
  tags,
});
