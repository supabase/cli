import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";

import { mockCommandSettings, useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { dbTargetSelectionOf } from "./db-target-flags.ts";
import {
  readWorkspaceTarget,
  resolveDbTarget,
  selectDbTarget,
  WorkspaceTargetError,
} from "./workspace-target.ts";

const NO_SELECTOR = dbTargetSelectionOf({ dbUrl: false, linked: false, local: false });

describe("selectDbTarget", () => {
  it("lets an explicit selector flag win over the workspace target", () => {
    const resolved = selectDbTarget({
      selection: dbTargetSelectionOf({ dbUrl: false, linked: false, local: true }),
      projectRefSet: false,
      workspaceTarget: "remote",
      legacyDefault: "linked",
    });

    expect(resolved).toMatchObject({ connType: "local", source: "selector", warn: false });
  });

  it("treats --project-ref as a selector that keeps the legacy default", () => {
    const resolved = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: true,
      workspaceTarget: "local",
      legacyDefault: "linked",
    });

    expect(resolved).toMatchObject({ connType: "linked", source: "selector", warn: false });
  });

  it("maps the workspace target onto a connection type without warning", () => {
    const remote = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: false,
      workspaceTarget: "remote",
      legacyDefault: "local",
    });
    const local = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: false,
      workspaceTarget: "local",
      legacyDefault: "linked",
    });

    expect(remote).toMatchObject({ connType: "linked", source: "workspace", warn: false });
    expect(local).toMatchObject({ connType: "local", source: "workspace", warn: false });
  });

  it("falls back to the legacy default and flags only a linked default for the warning", () => {
    const linkedDefault = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: false,
      workspaceTarget: undefined,
      legacyDefault: "linked",
    });
    const localDefault = selectDbTarget({
      selection: NO_SELECTOR,
      projectRefSet: false,
      workspaceTarget: undefined,
      legacyDefault: "local",
    });

    expect(linkedDefault).toMatchObject({ connType: "linked", source: "legacy", warn: true });
    expect(localDefault).toMatchObject({ connType: "local", source: "legacy", warn: false });
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

  it.effect("reads target from the config file", () => {
    writeConfig('project_id = "demo"\ntarget = "remote"\n');
    return readWorkspaceTarget().pipe(
      Effect.tap((target) => Effect.sync(() => expect(target).toBe("remote"))),
      Effect.provide(layerFor().layer),
    );
  });

  it.effect("reads target from a JSON config file", () => {
    writeConfig('{"project_id":"demo","target":"local"}', "config.json");
    return readWorkspaceTarget().pipe(
      Effect.tap((target) => Effect.sync(() => expect(target).toBe("local"))),
      Effect.provide(layerFor().layer),
    );
  });

  it.effect("lets SUPABASE_TARGET beat the config file", () => {
    writeConfig('target = "remote"\n');
    return readWorkspaceTarget().pipe(
      Effect.tap((target) => Effect.sync(() => expect(target).toBe("local"))),
      Effect.provide(layerFor({ SUPABASE_TARGET: "local" }).layer),
    );
  });

  it.effect("reads SUPABASE_TARGET from the project .env when the shell has none", () => {
    mkdirSync(join(workdir.current, "supabase"), { recursive: true });
    writeFileSync(join(workdir.current, "supabase", ".env"), "SUPABASE_TARGET=remote\n");
    return readWorkspaceTarget().pipe(
      Effect.tap((target) => Effect.sync(() => expect(target).toBe("remote"))),
      Effect.provide(layerFor().layer),
    );
  });

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
        'Warning: supabase db dump will target the local database by default in the next major version. Pass --linked, or set target = "remote" in supabase/config.toml (or SUPABASE_TARGET=remote), to keep targeting the linked project.',
      );
      expect(out.stderrText.match(/Warning:/g)).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not warn when the target is set", () => {
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
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not read or warn when a selector flag is given", () => {
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
