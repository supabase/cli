import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Redacted, Tracer } from "effect";

import { configValuesLayer } from "../../../tests/helpers/config-values-layer.ts";
import { VALID_REF, mockCommandSettings } from "../../../tests/helpers/command-mocks.ts";
import { ProjectRefNotLinkedError } from "../../config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import type { ProjectRefSource } from "../../config/project-ref.service.ts";
import { resolveTarget } from "./resolve-target.ts";
import { TargetPolicy } from "./target-policy.ts";
import type { TargetGroup } from "./target-policy.ts";
import type { TargetSelectorInput } from "./target-selector.ts";

const none: TargetSelectorInput = {
  local: false,
  linked: false,
  dbUrl: Option.none(),
  projectRef: Option.none(),
};

const FILE_REF = "filefilefilefilefile";
const FLAG_REF = "flagflagflagflagflag";

const projectRefResolver = (options: { readonly linked: boolean }) => {
  const flags: Array<Option.Option<string>> = [];
  const layer = Layer.succeed(ProjectRefResolver, {
    resolveRef: (flagValue) =>
      options.linked
        ? Effect.sync(() => {
            flags.push(flagValue);
            const source: ProjectRefSource = Option.isSome(flagValue) ? "flag" : "file";
            return {
              ref: Option.getOrElse(flagValue, () => FILE_REF),
              source,
              matchesLinkedRef: !Option.isSome(flagValue),
            };
          })
        : Effect.fail(new ProjectRefNotLinkedError({ message: "Cannot find project ref." })),
    resolve: () => Effect.die("resolve is not used by resolveTarget"),
    resolveForLink: () => Effect.die("resolveForLink is not used by resolveTarget"),
    resolveOptional: () => Effect.die("resolveOptional is not used by resolveTarget"),
    promptProjectRef: () => Effect.die("promptProjectRef is not used by resolveTarget"),
  });
  return { layer, flags };
};

const run = (
  group: TargetGroup,
  input: TargetSelectorInput,
  options: {
    readonly toml?: string;
    readonly dotenv?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly linked?: boolean;
    readonly projectId?: Option.Option<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "resolve-target-" });
    yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
    if (options.toml !== undefined) {
      yield* fs.writeFileString(path.join(dir, "supabase", "config.toml"), options.toml);
    }
    if (options.dotenv !== undefined) {
      yield* fs.writeFileString(path.join(dir, "supabase", ".env"), options.dotenv);
    }
    const resolver = projectRefResolver({ linked: options.linked ?? true });
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(spanOptions) {
        const span = new Tracer.NativeSpan(spanOptions);
        spans.push(span);
        return span;
      },
    });
    const exit = yield* resolveTarget(input).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(TargetPolicy, { group, consent: "none" }),
          resolver.layer,
          mockCommandSettings({
            workdir: dir,
            projectId: options.projectId ?? Option.none(),
          }),
          configValuesLayer({ env: options.env }),
        ),
      ),
      Effect.withTracer(tracer),
      Effect.withTracerEnabled(true),
      Effect.exit,
    );
    const attributes = spans.find((span) => span.name === "Target.resolve")?.attributes;
    return {
      exit,
      refFlags: resolver.flags,
      kind: attributes?.get("target.kind"),
      selection: attributes?.get("target.selection"),
    };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const succeeded = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`);
  return exit.value;
};

describe("resolveTarget (selectable)", () => {
  it.effect("is local when nothing selects a target", () =>
    Effect.gen(function* () {
      const result = yield* run("selectable", none);
      expect(succeeded(result.exit)).toEqual({ kind: "local" });
      expect(result.refFlags).toEqual([]);
      expect([result.kind, result.selection]).toEqual(["local", "default"]);
    }),
  );

  it.effect("follows a workspace target of remote to the linked project", () =>
    Effect.gen(function* () {
      const result = yield* run("selectable", none, { toml: 'target = "remote"\n' });
      expect(succeeded(result.exit)).toEqual({
        kind: "linked",
        ref: FILE_REF,
        source: "file",
        matchesLinkedRef: true,
      });
      expect(result.refFlags).toEqual([Option.none()]);
      expect([result.kind, result.selection]).toEqual(["linked", "config"]);
    }),
  );

  it.effect("lets SUPABASE_TARGET override the config file in both directions", () =>
    Effect.gen(function* () {
      const toRemote = yield* run("selectable", none, {
        toml: 'target = "local"\n',
        env: { SUPABASE_TARGET: "remote" },
      });
      expect(succeeded(toRemote.exit)).toMatchObject({ kind: "linked" });
      expect(toRemote.selection).toBe("env");

      const toLocal = yield* run("selectable", none, {
        toml: 'target = "remote"\n',
        env: { SUPABASE_TARGET: "local" },
      });
      expect(succeeded(toLocal.exit)).toEqual({ kind: "local" });
      expect(toLocal.selection).toBe("env");
    }),
  );

  it.effect("reads the workspace target from the project .env", () =>
    Effect.gen(function* () {
      const result = yield* run("selectable", none, { dotenv: "SUPABASE_TARGET=remote\n" });
      expect(succeeded(result.exit)).toMatchObject({ kind: "linked" });
      expect(result.selection).toBe("env");
    }),
  );

  it.effect("stays local when only SUPABASE_PROJECT_ID is set", () =>
    Effect.gen(function* () {
      const result = yield* run("selectable", none, { projectId: Option.some(VALID_REF) });
      expect(succeeded(result.exit)).toEqual({ kind: "local" });
      expect(result.refFlags).toEqual([]);
    }),
  );

  it.effect(
    "fails with not-linked instead of falling back to local when remote cannot resolve",
    () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", none, {
          toml: 'target = "remote"\n',
          linked: false,
        });
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(JSON.stringify(result.exit)).toContain("ProjectRefNotLinkedError");
      }),
  );

  it.effect("lets --linked beat a local workspace target", () =>
    Effect.gen(function* () {
      const result = yield* run(
        "selectable",
        { ...none, linked: true },
        { toml: 'target = "local"\n' },
      );
      expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FILE_REF });
      expect(result.selection).toBe("flag");
    }),
  );

  it.effect("lets --local beat a remote workspace target without resolving a ref", () =>
    Effect.gen(function* () {
      const result = yield* run(
        "selectable",
        { ...none, local: true },
        { toml: 'target = "remote"\n' },
      );
      expect(succeeded(result.exit)).toEqual({ kind: "local" });
      expect(result.refFlags).toEqual([]);
      expect(result.selection).toBe("flag");
    }),
  );

  it.effect("passes --project-ref to the ref chain and marks it a flag source", () =>
    Effect.gen(function* () {
      const result = yield* run("selectable", { ...none, projectRef: Option.some(FLAG_REF) });
      expect(succeeded(result.exit)).toEqual({
        kind: "linked",
        ref: FLAG_REF,
        source: "flag",
        matchesLinkedRef: false,
      });
      expect(result.refFlags).toEqual([Option.some(FLAG_REF)]);
    }),
  );

  it.effect("keeps the --db-url connection string redacted", () =>
    Effect.gen(function* () {
      const url = "postgres://user:secret@db.example.com:5432/postgres";
      const result = yield* run("selectable", { ...none, dbUrl: Option.some(url) });
      const target = succeeded(result.exit);
      expect(target.kind).toBe("db-url");
      if (target.kind === "db-url") expect(Redacted.value(target.url)).toBe(url);
      expect(JSON.stringify(target)).not.toContain("secret");
      expect(result.refFlags).toEqual([]);
    }),
  );

  it.effect("rejects conflicting selectors", () =>
    Effect.gen(function* () {
      const result = yield* run("selectable", { ...none, local: true, linked: true });
      expect(JSON.stringify(result.exit)).toContain("TargetSelectorConflictError");
    }),
  );
});

describe("resolveTarget (sync)", () => {
  it.effect("defaults to the linked project and ignores a local workspace target", () =>
    Effect.gen(function* () {
      const result = yield* run("sync", none, { toml: 'target = "local"\n' });
      expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FILE_REF });
      expect(result.refFlags).toEqual([Option.none()]);
      expect([result.kind, result.selection]).toEqual(["linked", "default"]);
    }),
  );

  it.effect("targets local only with --local", () =>
    Effect.gen(function* () {
      const result = yield* run("sync", { ...none, local: true });
      expect(succeeded(result.exit)).toEqual({ kind: "local" });
      expect(result.selection).toBe("flag");
    }),
  );

  it.effect("fails with not-linked when no project is linked", () =>
    Effect.gen(function* () {
      const result = yield* run("sync", none, { linked: false });
      expect(JSON.stringify(result.exit)).toContain("ProjectRefNotLinkedError");
    }),
  );
});

describe("resolveTarget (other groups)", () => {
  it.effect.each(["local-only", "account", "hosted", "removed"] satisfies Array<TargetGroup>)(
    "dies for a %s command",
    (group) =>
      Effect.gen(function* () {
        const result = yield* run(group, none);
        expect(Exit.isFailure(result.exit)).toBe(true);
        if (Exit.isFailure(result.exit)) {
          expect(Cause.pretty(result.exit.cause)).toContain(
            "resolveTarget needs a sync or selectable",
          );
        }
      }),
  );
});
