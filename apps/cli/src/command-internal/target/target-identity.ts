import { Option } from "effect";

import type { ProjectRefSource } from "../../config/project-ref.service.ts";
import type { RenderedTarget } from "../../shared/output/command-target.service.ts";
import { sanitizeInlineName } from "../http-errors.ts";
import type { CachedLinkedProject } from "../parent-project-ref.ts";

const hostWithPort = (host: string, port: number): string =>
  `${host.includes(":") ? `[${host}]` : host}:${port}`;

export const renderLocalTarget = (host: string, port: number): RenderedTarget => ({
  text: `local stack (${hostWithPort(sanitizeInlineName(host), port)})`,
  json: { kind: "local", host, port },
});

/** Names the host only; the connection string's credentials never reach the banner. */
export const renderDbUrlTarget = (host: string, port: number): RenderedTarget => ({
  text: `custom Postgres (${sanitizeInlineName(host)})`,
  json: { kind: "db-url", host, port },
});

const named = (name: string | undefined, ref: string): string => {
  const safeName = name === undefined ? "" : sanitizeInlineName(name);
  return safeName.length === 0 ? ref : `${safeName} (${ref})`;
};

/**
 * A linked project's environment from the `linked-project.json` cache alone, with no API call.
 * A cache naming the ref itself is a production project. A cache naming another project while the
 * ref came from `supabase/.temp/project-ref` is that project's branch, because `link <branch>`
 * stores the parent in the cache. Any other ref is unverified.
 */
export const describeLinkedTarget = (input: {
  readonly ref: string;
  readonly source: ProjectRefSource;
  readonly cache: Option.Option<CachedLinkedProject>;
}): RenderedTarget => {
  const { ref, source } = input;
  const cached = Option.getOrUndefined(input.cache);
  if (cached?.ref === ref) {
    return {
      text: `project ${named(cached.name, ref)} · production`,
      json: {
        kind: "linked",
        project_ref: ref,
        ...(cached.name === undefined ? {} : { project_name: cached.name }),
        environment: "production",
      },
    };
  }
  if (cached !== undefined && source === "file") {
    return {
      text: `project ${named(cached.name, cached.ref)} · branch (${ref})`,
      json: {
        kind: "linked",
        project_ref: ref,
        environment: "branch",
        parent_project_ref: cached.ref,
      },
    };
  }
  return {
    text: `project ${ref} · identity unverified`,
    json: { kind: "linked", project_ref: ref, environment: "unverified" },
  };
};

/** A branch resolved to its own project ref; `branch` is absent for a UUID lookup and `parentRef` for anything but a name lookup. */
export const renderBranchTarget = (input: {
  readonly branch: Option.Option<string>;
  readonly ref: string;
  readonly parentRef: Option.Option<string>;
}): RenderedTarget => {
  const branch = Option.map(input.branch, sanitizeInlineName);
  const parentRef = Option.getOrUndefined(input.parentRef);
  const label = Option.match(branch, {
    onNone: () => `branch ${input.ref}`,
    onSome: (name) => `branch ${name} (${input.ref})`,
  });
  return {
    text: parentRef === undefined ? label : `project ${parentRef} · ${label}`,
    json: {
      kind: "linked",
      project_ref: input.ref,
      environment: "branch",
      ...(parentRef === undefined ? {} : { parent_project_ref: parentRef }),
    },
  };
};
