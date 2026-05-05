import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const MUSL_TARGETS = [
  {
    bunTarget: "bun-linux-arm64-musl",
    pkg: "cli-linux-arm64-musl",
    nfpmArch: "arm64",
  },
  {
    bunTarget: "bun-linux-x64-musl",
    pkg: "cli-linux-x64-musl",
    nfpmArch: "amd64",
  },
] as const;

const LINUX_PKG_FORMATS = ["deb", "rpm", "apk"] as const;

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    shell: { type: "string", default: "next" },
  },
});

const version = values.version;
if (!version) {
  console.error(
    "Usage: pnpm exec bun apps/cli/scripts/build.ts --version <npm-version> --shell <legacy|next>",
  );
  process.exit(1);
}

const shell = values.shell;
if (shell !== "legacy" && shell !== "next") {
  console.error(`Invalid --shell value: ${String(shell)}. Expected "legacy" or "next".`);
  process.exit(1);
}

const TARGETS = [
  {
    bunTarget: "bun-darwin-arm64",
    pkg: "cli-darwin-arm64",
    archive: `supabase_${version}_darwin_arm64.tar.gz`,
    ext: "",
  },
  {
    bunTarget: "bun-darwin-x64",
    pkg: "cli-darwin-x64",
    archive: `supabase_${version}_darwin_amd64.tar.gz`,
    ext: "",
  },
  {
    bunTarget: "bun-linux-arm64",
    pkg: "cli-linux-arm64",
    archive: `supabase_${version}_linux_arm64.tar.gz`,
    nfpmArch: "arm64",
    ext: "",
  },
  {
    bunTarget: "bun-linux-x64",
    pkg: "cli-linux-x64",
    archive: `supabase_${version}_linux_amd64.tar.gz`,
    nfpmArch: "amd64",
    ext: "",
  },
  {
    bunTarget: "bun-windows-x64",
    pkg: "cli-windows-x64",
    archive: `supabase_${version}_windows_amd64.zip`,
    ext: ".exe",
  },
  {
    bunTarget: "bun-windows-arm64",
    pkg: "cli-windows-arm64",
    archive: `supabase_${version}_windows_arm64.zip`,
    ext: ".exe",
  },
] as const;

const root = path.resolve(import.meta.dir, "../../..");
const entrypoint = path.join(root, "apps/cli/src", shell, "main.ts");
const distDir = path.join(root, "dist");
const goSource = path.resolve(root, "apps/cli-go");

type BunTarget = (typeof TARGETS)[number]["bunTarget"];

const GO_TARGETS: Record<BunTarget, { goos: string; goarch: string }> = {
  "bun-darwin-arm64": { goos: "darwin", goarch: "arm64" },
  "bun-darwin-x64": { goos: "darwin", goarch: "amd64" },
  "bun-linux-arm64": { goos: "linux", goarch: "arm64" },
  "bun-linux-x64": { goos: "linux", goarch: "amd64" },
  "bun-windows-x64": { goos: "windows", goarch: "amd64" },
  "bun-windows-arm64": { goos: "windows", goarch: "arm64" },
};

async function buildTarget(target: (typeof TARGETS)[number]) {
  const binDir = path.join(root, "packages", target.pkg, "bin");
  await mkdir(binDir, { recursive: true });

  const outfile = path.join(binDir, `supabase${target.ext}`);

  console.log(`[${target.pkg}] Compiling Bun CLI...`);
  await $`bun build ${entrypoint} --compile --minify --target=${target.bunTarget} --define=process.env.SUPABASE_CLI_VERSION=${JSON.stringify(version)} --outfile=${outfile}`;
  console.log(`[${target.pkg}] Done.`);
}

async function buildGoTarget(target: (typeof TARGETS)[number]) {
  const binDir = path.join(root, "packages", target.pkg, "bin");
  await mkdir(binDir, { recursive: true });

  const { goos, goarch } = GO_TARGETS[target.bunTarget];
  const outfile = path.join(binDir, `supabase-go${target.ext}`);

  console.log(`[${target.pkg}] Compiling Go CLI (${goos}/${goarch})...`);
  await $`go build -trimpath -ldflags="-s -w" -o ${outfile} .`.cwd(goSource).env({
    ...process.env,
    GOOS: goos,
    GOARCH: goarch,
    CGO_ENABLED: "0",
  });
  console.log(`[${target.pkg}] Go binary done.`);
}

async function archiveTarget(target: (typeof TARGETS)[number]) {
  const binDir = path.join(root, "packages", target.pkg, "bin");
  const archivePath = path.join(distDir, target.archive);

  console.log(`[${target.pkg}] Creating archive ${target.archive}...`);

  if (target.archive.endsWith(".zip")) {
    const files = [path.join(binDir, `supabase${target.ext}`)];
    if (shell === "legacy") files.push(path.join(binDir, `supabase-go${target.ext}`));
    await $`zip -j ${archivePath} ${files}`;
  } else {
    const files = [`supabase${target.ext}`];
    if (shell === "legacy") files.push(`supabase-go${target.ext}`);
    await $`tar -czf ${archivePath} -C ${binDir} ${files}`;
  }
}

async function buildMuslBinaries() {
  await Promise.all(
    MUSL_TARGETS.map(async (target) => {
      const binDir = path.join(root, "packages", target.pkg, "bin");
      await mkdir(binDir, { recursive: true });

      const outfile = path.join(binDir, "supabase");
      console.log(`[${target.pkg}] Compiling Bun CLI (musl)...`);
      await $`bun build ${entrypoint} --compile --minify --target=${target.bunTarget} --define=process.env.SUPABASE_CLI_VERSION=${JSON.stringify(version)} --outfile=${outfile}`;
      console.log(`[${target.pkg}] Done.`);
    }),
  );
}

async function buildLinuxPackages(version: string) {
  const linuxTargets = TARGETS.filter((target) => "nfpmArch" in target);
  const jobs: Promise<void>[] = [];

  for (const target of linuxTargets) {
    const glibcBinDir = path.join(root, "packages", target.pkg, "bin");
    const muslTarget = MUSL_TARGETS.find((candidate) => candidate.nfpmArch === target.nfpmArch)!;
    const muslBinDir = path.join(root, "packages", muslTarget.pkg, "bin");

    for (const fmt of LINUX_PKG_FORMATS) {
      const outFile = `supabase_${version}_linux_${target.nfpmArch}.${fmt}`;
      const outPath = path.join(distDir, outFile);
      const binDir = fmt === "apk" ? muslBinDir : glibcBinDir;

      // Go binary is CGO_ENABLED=0 (fully static), so the glibc Linux build works on
      // musl too. For apk (musl), binDir is muslBinDir for the TS binary but we still
      // reference supabase-go from the glibc dir where it was built.
      const contents: Array<{ src: string; dst: string }> = [
        { src: path.join(binDir, "supabase"), dst: "/usr/bin/supabase" },
      ];
      if (shell === "legacy") {
        contents.push({
          src: path.join(glibcBinDir, "supabase-go"),
          dst: "/usr/bin/supabase-go",
        });
      }

      const nfpmConfig: Record<string, unknown> = {
        name: "supabase",
        arch: target.nfpmArch,
        platform: "linux",
        version,
        maintainer: "Supabase <support@supabase.io>",
        description: "Supabase CLI",
        homepage: "https://supabase.com",
        license: "MIT",
        contents,
      };

      if (fmt === "apk") {
        nfpmConfig.depends = ["libstdc++", "libgcc"];
      }

      const configPath = path.join(distDir, `nfpm-${target.nfpmArch}-${fmt}.yaml`);
      await writeFile(configPath, JSON.stringify(nfpmConfig));

      jobs.push(
        (async () => {
          console.log(`[${target.pkg}] Creating ${outFile}...`);
          await $`nfpm package --config ${configPath} --packager ${fmt} --target ${outPath}`;
          await rm(configPath);
        })(),
      );
    }
  }

  await Promise.all(jobs);
}

async function generateChecksums() {
  const lines: string[] = [];

  for (const target of TARGETS) {
    const archivePath = path.join(distDir, target.archive);
    const data = await readFile(archivePath);
    const hash = createHash("sha256").update(data).digest("hex");
    lines.push(`${hash}  ${target.archive}`);
  }

  const linuxTargets = TARGETS.filter((target) => "nfpmArch" in target);
  for (const target of linuxTargets) {
    for (const fmt of LINUX_PKG_FORMATS) {
      const filename = `supabase_${version}_linux_${target.nfpmArch}.${fmt}`;
      const data = await readFile(path.join(distDir, filename));
      const hash = createHash("sha256").update(data).digest("hex");
      lines.push(`${hash}  ${filename}`);
    }
  }

  const checksumsPath = path.join(distDir, "checksums.txt");
  await writeFile(checksumsPath, `${lines.join("\n")}\n`);
  console.log("Checksums written to dist/checksums.txt");
}

console.log(`Building ${shell} CLI for ${TARGETS.length} targets...\n`);

await Promise.all(TARGETS.map(buildTarget));

if (shell === "legacy") {
  console.log("\nCompiling Go CLI for all targets...");
  await Promise.all(TARGETS.map(buildGoTarget));
}

await mkdir(distDir, { recursive: true });
await Promise.all(TARGETS.map(archiveTarget));

await buildMuslBinaries();
await buildLinuxPackages(version);
await generateChecksums();

console.log(`\nAll ${shell} targets built successfully.`);
