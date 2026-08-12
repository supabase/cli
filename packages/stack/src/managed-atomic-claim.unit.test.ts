import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimFileAtomically } from "./managed/atomic-claim.ts";

const temporaryRoots: Array<string> = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atomic-claim-test-"));
  temporaryRoots.push(root);
  return root;
};

const codedError = (code: string): Error => Object.assign(new Error(code), { code });

const refusingLink = (code: string) => (): Promise<never> => Promise.reject(codedError(code));

const strayTemporaryFiles = (root: string): ReadonlyArray<string> =>
  readdirSync(root).filter((entry) => entry.includes(".tmp."));

describe("atomic file claim", () => {
  it("publishes the content when nothing holds the path yet", async () => {
    const root = makeRoot();
    const target = join(root, "claim.json");

    await expect(claimFileAtomically(target, "mine\n", { mode: 0o600 })).resolves.toBe("claimed");

    expect(readFileSync(target, "utf8")).toBe("mine\n");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(strayTemporaryFiles(root)).toEqual([]);
  });

  it("reports a claim someone else already published and leaves it untouched", async () => {
    const root = makeRoot();
    const target = join(root, "claim.json");
    writeFileSync(target, "theirs\n");

    await expect(claimFileAtomically(target, "mine\n")).resolves.toBe("already-exists");

    expect(readFileSync(target, "utf8")).toBe("theirs\n");
    expect(strayTemporaryFiles(root)).toEqual([]);
  });

  it.each(["EPERM", "ENOTSUP"])(
    "claims through an exclusive create where hardlinks refuse with %s",
    async (code) => {
      const root = makeRoot();
      const target = join(root, "claim.json");

      await expect(
        claimFileAtomically(target, "mine\n", { mode: 0o600, linkFile: refusingLink(code) }),
      ).resolves.toBe("claimed");

      expect(readFileSync(target, "utf8")).toBe("mine\n");
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(strayTemporaryFiles(root)).toEqual([]);
    },
  );

  it("still settles the race for a loser on a filesystem without hardlinks", async () => {
    const root = makeRoot();
    const target = join(root, "claim.json");
    writeFileSync(target, "theirs\n");

    await expect(
      claimFileAtomically(target, "mine\n", { linkFile: refusingLink("EPERM") }),
    ).resolves.toBe("already-exists");

    expect(readFileSync(target, "utf8")).toBe("theirs\n");
    expect(strayTemporaryFiles(root)).toEqual([]);
  });

  it("propagates a publication failure that is neither a lost race nor a missing hardlink", async () => {
    const root = makeRoot();
    const target = join(root, "claim.json");

    await expect(
      claimFileAtomically(target, "mine\n", { linkFile: refusingLink("EACCES") }),
    ).rejects.toThrow("EACCES");

    expect(readdirSync(root)).toEqual([]);
  });

  it("names the temporary file from an injected identifier so a run stays reproducible", async () => {
    const root = makeRoot();
    const target = join(root, "claim.json");
    const observed: Array<string> = [];

    await claimFileAtomically(target, "mine\n", {
      temporaryId: "fixed-id",
      linkFile: (existingPath) => {
        observed.push(existingPath);
        return Promise.reject(codedError("EPERM"));
      },
    });

    expect(observed).toEqual([`${target}.tmp.fixed-id`]);
    expect(strayTemporaryFiles(root)).toEqual([]);
  });
});
