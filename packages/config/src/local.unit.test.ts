import { Schema } from "effect";
import { parse } from "smol-toml";
import { describe, expect, test } from "vitest";
import { CliConfigSchema } from "./base.ts";
import { fromConfigDocument } from "./project-config/project-config.ts";

const decode = (toml: string) =>
  Schema.decodeSync(CliConfigSchema)(parse(toml), { onExcessProperty: "error" });

const services = (entries: string) => `[local.services]\n${entries}\n`;

describe("[local.services]", () => {
  test("decodes version specifiers and keeps them out of the hosted projection", () => {
    const document = decode(
      services(
        [
          'default = { version = "bundled" }',
          'auth = { version = "v2.197.0" }',
          'storage = { version = "v1.30.2-r1" }',
          'realtime = { version = "v2.34.47-r0" }',
          'studio = { version = "2025.06.30-sha-6f5982d" }',
          'database = { version = "17.6.1.200-orioledb-r2" }',
          'rest = { version = "linked" }',
        ].join("\n"),
      ),
    );

    expect(document.local?.services?.database).toEqual({ version: "17.6.1.200-orioledb-r2" });
    expect(document.local?.services?.realtime).toEqual({ version: "v2.34.47-r0" });
    expect(document.local?.services?.studio).toEqual({ version: "2025.06.30-sha-6f5982d" });
    expect(Object.keys(fromConfigDocument(document))).not.toContain("local");
  });

  test("rejects a service key outside the closed set", () => {
    expect(() => decode(services('kong = { version = "bundled" }'))).toThrow(/kong/u);
  });

  test("rejects a [local] key outside services", () => {
    expect(() => decode("[local]\nports = {}\n")).toThrow(/ports/u);
  });

  test("is not accepted in a remote block", () => {
    expect(() =>
      decode(
        '[remotes.prod]\nproject_id = "abc"\n[remotes.prod.local.services]\nauth = { version = "v1" }\n',
      ),
    ).toThrow(/local/u);
  });

  test.each([
    ["auth", "v2.197.0-r", /local\.services\.auth\.version/u],
    ["auth", "v2.197.0-r01", /local\.services\.auth\.version/u],
    ["auth", "v2 197", /local\.services\.auth\.version/u],
    ["auth", "v2.197.0+build", /local\.services\.auth\.version/u],
    ["auth", "-v1", /local\.services\.auth\.version/u],
    ["auth", "default", /local\.services\.auth\.version "default"/u],
    ["auth", "17.6.1.200-orioledb", /orioledb.*only valid for the database/u],
    [
      "default",
      "v2.197.0",
      /local\.services\.default\.version "v2.197.0" must be "linked" or "bundled"/u,
    ],
  ])("rejects %s version %j", (key, version, message) => {
    expect(() => decode(services(`${key} = { version = "${version}" }`))).toThrow(message);
  });

  test("reports only the first bad service version", () => {
    let message = "";
    try {
      decode(services('auth = { version = "v2 197" }\nrest = { version = "default" }'));
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/local\.services\.auth\.version/u);
    expect(message).not.toMatch(/local\.services\.rest\.version/u);
  });

  test("accepts a container-only entry with no version", () => {
    const document = decode(
      services(
        [
          "[local.services.database.container]",
          'memory = "768MiB"',
          "cpus = 1.5",
          "[local.services.rest.container]",
          'memory = "1g"',
        ].join("\n"),
      ),
    );

    expect(document.local?.services?.database).toEqual({
      container: { memory: "768MiB", cpus: 1.5 },
    });
    expect(document.local?.services?.rest).toEqual({ container: { memory: "1g" } });
  });

  test.each([
    ["an unknown unit", 'memory = "12XB"', /"auth"\]\["container"\]\["memory"\]/u],
    ["no number", 'memory = "MiB"', /"auth"\]\["container"\]\["memory"\]/u],
    ["a size below Docker's minimum", 'memory = "5MiB"', /at least 6MiB/u],
    ["an unrepresentable size", 'memory = "8PiB"', /less than 8PiB/u],
    ["an overflowing size", `memory = "${"9".repeat(309)}"`, /less than 8PiB/u],
    [
      "cpus below Docker's minimum",
      "cpus = 0.009",
      /at least 0.01[\s\S]*"auth"\]\["container"\]\["cpus"\]/u,
    ],
    ["negative cpus", "cpus = -1", /"auth"\]\["container"\]\["cpus"\]/u],
    ["string cpus", 'cpus = "2"', /"auth"\]\["container"\]\["cpus"\]/u],
  ])("rejects a container with %s", (_name, line, message) => {
    expect(() => decode(services(`[local.services.auth.container]\n${line}`))).toThrow(message);
  });

  test("rejects container limits under default", () => {
    expect(() =>
      decode(
        services(
          '[local.services.default]\nversion = "bundled"\n[local.services.default.container]\nmemory = "1GiB"',
        ),
      ),
    ).toThrow(/"default"\]\["container"\]/u);
  });
});
