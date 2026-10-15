import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";

import { mockCommandSettings, useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { dbTargetSelectionOf } from "./db-target-flags.ts";
import {
  originFromPath,
  passwordDroppedByWorkspaceTarget,
  readWorkspaceTarget,
  resolveDbTarget,
  selectDbTarget,
  WorkspaceTargetError,
} from "./workspace-target.ts";

const NO_SELECTOR = dbTargetSelectionOf({ dbUrl: false, linked: false, local: false });
const REMOTE = { target: "remote", origin: "supabase/config.toml" } as const;
const LOCAL = { target: "local", origin: "supabase/config.toml" } as const;

describe("selectDbTarget", () => {
  it("lets an explicit selector flag win over the workspace target", () => {
    const resolved = selectDbTarget({
      selection: dbTargetSelectionOf({ dbUrl: false, linked: false, local: true }),
      projectRefSet: false,
      workspace: REMOTE,
      legacyDefault: "linked",
    });

    expect(resolved).toMatchObject({
      connType: "local",
      source: "selector",
      origin: undefined,
      warn: false,
    });
  });

  it("keeps the legacy default for --project-ref when the workspace target is local", () => {
    const resolved = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: true,
      workspace: LOCAL,
      legacyDefault: "linked",
    });

    expect(resolved).toMatchObject({ connType: "linked", source: "selector", warn: false });
  });

  it("keeps the legacy default for --project-ref when no workspace target is set", () => {
    const linkedDefault = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: true,
      workspace: undefined,
      legacyDefault: "linked",
    });
    const localDefault = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: true,
      workspace: undefined,
      legacyDefault: "local",
    });

    expect(linkedDefault).toMatchObject({ connType: "linked", source: "selector", warn: false });
    expect(localDefault).toMatchObject({ connType: "local", source: "selector", warn: false });
  });

  it("resolves --project-ref to the linked project when the workspace target is remote", () => {
    const resolved = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: true,
      workspace: REMOTE,
      legacyDefault: "local",
    });

    expect(resolved).toMatchObject({
      connType: "linked",
      source: "workspace",
      origin: "supabase/config.toml",
      warn: false,
    });
  });

  it("maps the workspace target onto a connection type without warning", () => {
    const remote = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: false,
      workspace: REMOTE,
      legacyDefault: "local",
    });
    const local = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: false,
      workspace: LOCAL,
      legacyDefault: "linked",
    });

    expect(remote).toMatchObject({ connType: "linked", source: "workspace", warn: false });
    expect(local).toMatchObject({ connType: "local", source: "workspace", warn: false });
  });

  it("falls back to the legacy default and flags only a linked default for the warning", () => {
    const linkedDefault = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: false,
      workspace: undefined,
      legacyDefault: "linked",
    });
    const localDefault = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: false,
      workspace: undefined,
      legacyDefault: "local",
    });

    expect(linkedDefault).toMatchObject({ connType: "linked", source: "legacy", warn: true });
    expect(localDefault).toMatchObject({ connType: "local", source: "legacy", warn: false });
  });
});

describe("passwordDroppedByWorkspaceTarget", () => {
  const resolve = (workspace: typeof LOCAL | typeof REMOTE | undefined) =>
    selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: false,
      workspace,
      legacyDefault: "linked",
    });

  it("fails a password when the workspace target resolves to local", () => {
    expect(passwordDroppedByWorkspaceTarget(resolve(LOCAL), Option.some("pw"))).toBe(
      '--password only applies when targeting the linked project, but target = "local" is set (supabase/config.toml); use --linked or set target = "remote"',
    );
  });

  it("lets a password through when the target is linked, absent, or no password was given", () => {
    expect(passwordDroppedByWorkspaceTarget(resolve(REMOTE), Option.some("pw"))).toBeUndefined();
    expect(passwordDroppedByWorkspaceTarget(resolve(undefined), Option.some("pw"))).toBeUndefined();
    expect(passwordDroppedByWorkspaceTarget(resolve(LOCAL), Option.none())).toBeUndefined();
  });

  it("lets a password through when a selector flag chose the target", () => {
    const selected = selectDbTarget({
      selection: dbTargetSelectionOf({ dbUrl: false, linked: false, local: true }),
      projectRefSet: false,
      workspace: LOCAL,
      legacyDefault: "linked",
    });

    expect(passwordDroppedByWorkspaceTarget(selected, Option.some("pw"))).toBeUndefined();
  });
});

describe("originFromPath", () => {
  it("shows a workdir-relative path with forward slashes", () => {
    expect(originFromPath("C:\\work\\app", "C:\\work\\app\\supabase\\config.toml")).toBe(
      "supabase/config.toml",
    );
  });
});

describe("workspace target resolution", () => {
  const workdir = useTempWorkdir("supabase-workspace-target-");

  const writeConfig = (content: string, fileName = "config.toml") => {
    mkdirSync(join(workdir.current, "supabase"), { recursive: true });
    writeFileSync(join(workdir.current, "supabase", fileName), content);
  };

  const layerFor = (env: Record<string, string> = {}) => {
    const out = mockOutput();
    const layer = Layer.mergeAll(
      out.layer,
      BunServices.layer,
      mockCommandSettings({ workdir: workdir.current, explicitWorkdir: true }),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
    );
    return { out, layer };
  };

  it.effect("reads target from the config file and names it as the origin", () => {
    writeConfig('project_id = "demo"\ntarget = "remote"\n');
    return readWorkspaceTarget().pipe(
      Effect.tap((reading) =>
        Effect.sync(() =>
          expect(reading).toEqual({ target: "remote", origin: "supabase/config.toml" }),
        ),
      ),
      Effect.provide(layerFor().layer),
    );
  });

  it.effect("reads target from a JSON config file and names it as the origin", () => {
    writeConfig('{"project_id":"demo","target":"local"}', "config.json");
    return readWorkspaceTarget().pipe(
      Effect.tap((reading) =>
        Effect.sync(() =>
          expect(reading).toEqual({ target: "local", origin: "supabase/config.json" }),
        ),
      ),
      Effect.provide(layerFor().layer),
    );
  });

  it.effect("lets SUPABASE_TARGET beat the config file", () => {
    writeConfig('target = "remote"\n');
    return readWorkspaceTarget().pipe(
      Effect.tap((reading) =>
        Effect.sync(() => expect(reading).toEqual({ target: "local", origin: "SUPABASE_TARGET" })),
      ),
      Effect.provide(layerFor({ SUPABASE_TARGET: "local" }).layer),
    );
  });

  it.effect("reads SUPABASE_TARGET from the project .env when the shell has none", () => {
    mkdirSync(join(workdir.current, "supabase"), { recursive: true });
    writeFileSync(join(workdir.current, "supabase", ".env"), "SUPABASE_TARGET=remote\n");
    return readWorkspaceTarget().pipe(
      Effect.tap((reading) =>
        Effect.sync(() => expect(reading).toEqual({ target: "remote", origin: "supabase/.env" })),
      ),
      Effect.provide(layerFor().layer),
    );
  });

  it.effect("names the file that supplied SUPABASE_TARGET, relative to the workdir", () => {
    mkdirSync(join(workdir.current, "supabase"), { recursive: true });
    writeFileSync(join(workdir.current, ".env.local"), "SUPABASE_TARGET=remote\n");
    writeFileSync(join(workdir.current, ".env"), "SUPABASE_TARGET=local\n");
    return readWorkspaceTarget().pipe(
      Effect.tap((reading) =>
        Effect.sync(() => expect(reading).toEqual({ target: "remote", origin: ".env.local" })),
      ),
      Effect.provide(layerFor().layer),
    );
  });

  it.effect("prefers supabase/.env.local over a workdir .env.local", () => {
    mkdirSync(join(workdir.current, "supabase"), { recursive: true });
    writeFileSync(join(workdir.current, "supabase", ".env.local"), "SUPABASE_TARGET=local\n");
    writeFileSync(join(workdir.current, ".env.local"), "SUPABASE_TARGET=remote\n");
    return readWorkspaceTarget().pipe(
      Effect.tap((reading) =>
        Effect.sync(() =>
          expect(reading).toEqual({ target: "local", origin: "supabase/.env.local" }),
        ),
      ),
      Effect.provide(layerFor().layer),
    );
  });

  it.effect(
    "credits the shell when the shell and the project .env both set SUPABASE_TARGET",
    () => {
      mkdirSync(join(workdir.current, "supabase"), { recursive: true });
      writeFileSync(join(workdir.current, "supabase", ".env"), "SUPABASE_TARGET=local\n");
      return readWorkspaceTarget().pipe(
        Effect.tap((reading) =>
          Effect.sync(() =>
            expect(reading).toEqual({ target: "remote", origin: "SUPABASE_TARGET" }),
          ),
        ),
        Effect.provide(layerFor({ SUPABASE_TARGET: "remote" }).layer),
      );
    },
  );

  it.effect("treats a missing or unparsable config as unset", () => {
    const empty = layerFor();
    return Effect.gen(function* () {
      expect(yield* readWorkspaceTarget()).toBeUndefined();
      writeConfig("not = [valid toml");
      expect(yield* readWorkspaceTarget()).toBeUndefined();
    }).pipe(Effect.provide(empty.layer));
  });

  it.effect("rejects an invalid SUPABASE_TARGET", () =>
    Effect.gen(function* () {
      const error = yield* readWorkspaceTarget().pipe(Effect.flip);
      expect(error).toBeInstanceOf(WorkspaceTargetError);
      expect(error.message).toBe(
        'SUPABASE_TARGET must be "local" or "remote" when set, got "prod"',
      );
    }).pipe(Effect.provide(layerFor({ SUPABASE_TARGET: "prod" }).layer)),
  );

  it.effect("names the env file that supplied an invalid SUPABASE_TARGET", () => {
    writeFileSync(join(workdir.current, ".env.local"), "SUPABASE_TARGET=prod\n");
    return Effect.gen(function* () {
      const error = yield* readWorkspaceTarget().pipe(Effect.flip);
      expect(error).toBeInstanceOf(WorkspaceTargetError);
      expect(error.message).toBe(
        'SUPABASE_TARGET in .env.local must be "local" or "remote" when set, got "prod"',
      );
    }).pipe(Effect.provide(layerFor().layer));
  });

  it.effect("rejects an invalid target in the config file", () => {
    writeConfig('target = "production"\n');
    return Effect.gen(function* () {
      const error = yield* readWorkspaceTarget().pipe(Effect.flip);
      expect(error).toBeInstanceOf(WorkspaceTargetError);
      expect(error.message).toContain('must be "local" or "remote"');
    }).pipe(Effect.provide(layerFor().layer));
  });

  it.effect("warns once on stderr when a linked default has no target and no selector", () => {
    const { out, layer } = layerFor();
    return Effect.gen(function* () {
      const resolved = yield* resolveDbTarget({
        command: "db dump",
        selection: NO_SELECTOR,
        projectRefSet: false,
        legacyDefault: "linked",
      });

      expect(resolved).toMatchObject({ connType: "linked", source: "legacy" });
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toContain(
        'Warning: supabase db dump will target the local database by default in the next major version. Pass --linked to keep targeting the linked project. Setting target = "remote" in your Supabase config (or SUPABASE_TARGET=remote) also works, but applies to every database command that can run locally, including db reset.',
      );
      expect(out.stderrText.match(/Warning:/g)).toHaveLength(1);
      expect(out.stderrText).not.toContain("Targeting the linked project");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "names the config file on stderr when the target resolves to the linked project",
    () => {
      writeConfig('target = "remote"\n');
      const { out, layer } = layerFor();
      return Effect.gen(function* () {
        const resolved = yield* resolveDbTarget({
          command: "db dump",
          selection: NO_SELECTOR,
          projectRefSet: false,
          legacyDefault: "linked",
        });

        expect(resolved).toMatchObject({ connType: "linked", source: "workspace" });
        expect(out.stdoutText).toBe("");
        expect(out.stderrText).toBe(
          'Targeting the linked project (target = "remote" from supabase/config.toml)\n',
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "names SUPABASE_TARGET on stderr when the env variable picks the linked project",
    () => {
      const { out, layer } = layerFor({ SUPABASE_TARGET: "remote" });
      return Effect.gen(function* () {
        yield* resolveDbTarget({
          command: "db lint",
          selection: NO_SELECTOR,
          projectRefSet: false,
          legacyDefault: "local",
        });

        expect(out.stderrText).toBe(
          'Targeting the linked project (target = "remote" from SUPABASE_TARGET)\n',
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "names supabase/.env on stderr when the project env file picks the linked project",
    () => {
      mkdirSync(join(workdir.current, "supabase"), { recursive: true });
      writeFileSync(join(workdir.current, "supabase", ".env"), "SUPABASE_TARGET=remote\n");
      const { out, layer } = layerFor();
      return Effect.gen(function* () {
        yield* resolveDbTarget({
          command: "db lint",
          selection: NO_SELECTOR,
          projectRefSet: false,
          legacyDefault: "local",
        });

        expect(out.stderrText).toBe(
          'Targeting the linked project (target = "remote" from supabase/.env)\n',
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("names the JSON config file on stderr when it picks the linked project", () => {
    writeConfig('{"target":"remote"}', "config.json");
    const { out, layer } = layerFor();
    return Effect.gen(function* () {
      yield* resolveDbTarget({
        command: "db lint",
        selection: NO_SELECTOR,
        projectRefSet: false,
        legacyDefault: "local",
      });

      expect(out.stderrText).toBe(
        'Targeting the linked project (target = "remote" from supabase/config.json)\n',
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves --project-ref to the linked project when the target is remote", () => {
    writeConfig('target = "remote"\n');
    const { out, layer } = layerFor();
    return Effect.gen(function* () {
      const resolved = yield* resolveDbTarget({
        command: "db lint",
        selection: NO_SELECTOR,
        projectRefSet: true,
        legacyDefault: "local",
      });

      expect(resolved).toMatchObject({ connType: "linked", source: "workspace" });
      expect(out.stderrText).toContain("Targeting the linked project");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "keeps --project-ref on the legacy default without output when the target is local",
    () => {
      writeConfig('target = "local"\n');
      const { out, layer } = layerFor();
      return Effect.gen(function* () {
        const resolved = yield* resolveDbTarget({
          command: "db dump",
          selection: NO_SELECTOR,
          projectRefSet: true,
          legacyDefault: "linked",
        });

        expect(resolved).toMatchObject({ connType: "linked", source: "selector" });
        expect(out.stderrText).toBe("");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("stays silent when the target resolves to the local database", () => {
    writeConfig('target = "local"\n');
    const { out, layer } = layerFor();
    return Effect.gen(function* () {
      const resolved = yield* resolveDbTarget({
        command: "db dump",
        selection: NO_SELECTOR,
        projectRefSet: false,
        legacyDefault: "linked",
      });

      expect(resolved).toMatchObject({ connType: "local", source: "workspace" });
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not read, warn, or name a source when a selector flag is given", () => {
    writeConfig('target = "nonsense"\n');
    const { out, layer } = layerFor({ SUPABASE_TARGET: "also-nonsense" });
    return Effect.gen(function* () {
      const resolved = yield* resolveDbTarget({
        command: "db dump",
        selection: dbTargetSelectionOf({ dbUrl: false, linked: true, local: false }),
        projectRefSet: false,
        legacyDefault: "linked",
      });

      expect(resolved).toMatchObject({ connType: "linked", source: "selector" });
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("never warns for a command whose legacy default is already local", () => {
    const { out, layer } = layerFor();
    return Effect.gen(function* () {
      const resolved = yield* resolveDbTarget({
        command: "db lint",
        selection: NO_SELECTOR,
        projectRefSet: false,
        legacyDefault: "local",
      });

      expect(resolved).toMatchObject({ connType: "local", source: "legacy" });
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });
});
