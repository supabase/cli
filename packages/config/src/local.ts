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

const serviceEntry = Schema.Struct({
  version: Schema.String.annotate({
    description:
      "Version specifier: `linked` (the linked project's version), `bundled` (the version shipped with this CLI), or an upstream version optionally followed by `-r<N>`. A `-orioledb` version is only valid for `database`.",
    examples: ["bundled", "v2.197.0", "v1.30.2-r1", "17.6.1.200-orioledb"],
    tags,
  }),
});

const entry = Schema.optionalKey(serviceEntry);

const services = Schema.Struct({
  default: entry,
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
    description: "Per-service version specifiers for the local stack, keyed by service.",
    tags,
  })
  .check(
    Schema.makeFilter(
      (value: { readonly [key: string]: { readonly version: string } | undefined }) => {
        for (const [key, entry] of Object.entries(value)) {
          const issue = entry === undefined ? undefined : versionIssue(key, entry.version);
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
