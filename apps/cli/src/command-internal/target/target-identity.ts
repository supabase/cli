import { Option } from "effect";

import type { RenderedTarget } from "../../shared/output/command-target.service.ts";
import { sanitizeInlineName } from "../http-errors.ts";
import type { CachedLinkedProject } from "../parent-project-ref.ts";

const hostWithPort = (host: string, port: number): string =>
  `${host.includes(":") ? `[${host}]` : host}:${port}`;

export const renderLocalTarget = (host: string, port: number): RenderedTarget => ({
  text: `local stack (${hostWithPort(sanitizeInlineName(host), port)})`,
  json: { kind: "local", host, port },
});

/** Names the host and port only; the connection string's credentials never reach the banner. */
export const renderDbUrlTarget = (host: string, port: number): RenderedTarget => ({
  text: `custom Postgres (${hostWithPort(sanitizeInlineName(host), port)})`,
  json: { kind: "db-url", host, port },
});

const named = (name: string | undefined, ref: string): string => {
  const safeName = name === undefined ? "" : sanitizeInlineName(name);
  return safeName.length === 0 ? ref : `${safeName} (${ref})`;
};

/**
 * A linked project's identity from the `linked-project.json` cache alone, with no API call. Only a
 * cache naming the resolved ref itself is evidence (a production project); a project that is
 * merely linked, or one the cache cannot vouch for, is shown as its ref and reported `unverified`,
 * because the cache can be stale or missing and never proves a branch. A ref that differs from
 * the linked project's own says so.
 */
export const describeLinkedTarget = (input: {
  readonly ref: string;
  readonly cache: Option.Option<CachedLinkedProject>;
  /** The name the project picker showed for `ref`. */
  readonly name?: string;
  /** The ref in `supabase/.temp/project-ref`, when the caller compares against the linked project. */
  readonly linkedRef?: Option.Option<string>;
}): RenderedTarget => {
  const { ref } = input;
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
  const differsFromLinked = Option.exists(
    input.linkedRef ?? Option.none(),
    (linked) => linked !== ref,
  );
  return {
    text: `project ${named(input.name, ref)}${differsFromLinked ? " (not the linked project)" : ""}`,
    json: {
      kind: "linked",
      project_ref: ref,
      ...(input.name === undefined ? {} : { project_name: input.name }),
      environment: "unverified",
    },
  };
};

/** The suffix a default-local banner carries when the checkout is linked, naming the project `--linked` would use. */
export const linkedAlternativeHint = (input: {
  readonly ref: string;
  readonly cache: Option.Option<CachedLinkedProject>;
}): string => {
  const cached = Option.getOrUndefined(input.cache);
  const name = cached?.ref === input.ref ? cached.name : undefined;
  return `default; pass --linked for ${named(name, input.ref)}`;
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
