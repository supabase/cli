import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const MUSL_TARGETS = [
	{ bunTarget: "bun-linux-arm64-musl", nfpmArch: "arm64", goAsset: "supabase_linux_arm64.tar.gz" },
	{ bunTarget: "bun-linux-x64-musl", nfpmArch: "amd64", goAsset: "supabase_linux_amd64.tar.gz" },
] as const;

const LINUX_PKG_FORMATS = ["deb", "rpm", "apk"] as const;

const { values } = parseArgs({
	options: {
		"go-version": { type: "string" },
		version: { type: "string" },
	},
});

const goVersion = values["go-version"];
const version = values.version;
if (!goVersion || !version) {
	console.error(
		"Usage: bun run scripts/build.ts --go-version <version> --version <npm-version>",
	);
	process.exit(1);
}

const TARGETS = [
	{
		bunTarget: "bun-darwin-arm64",
		pkg: "cli-darwin-arm64",
		goAsset: "supabase_darwin_arm64.tar.gz",
		archive: `supabase_${version}_darwin_arm64.tar.gz`,
		ext: "",
	},
	{
		bunTarget: "bun-darwin-x64",
		pkg: "cli-darwin-x64",
		goAsset: "supabase_darwin_amd64.tar.gz",
		archive: `supabase_${version}_darwin_amd64.tar.gz`,
		ext: "",
	},
	{
		bunTarget: "bun-linux-arm64",
		pkg: "cli-linux-arm64",
		goAsset: "supabase_linux_arm64.tar.gz",
		archive: `supabase_${version}_linux_arm64.tar.gz`,
		nfpmArch: "arm64",
		ext: "",
	},
	{
		bunTarget: "bun-linux-x64",
		pkg: "cli-linux-x64",
		goAsset: "supabase_linux_amd64.tar.gz",
		archive: `supabase_${version}_linux_amd64.tar.gz`,
		nfpmArch: "amd64",
		ext: "",
	},
	{
		bunTarget: "bun-windows-x64",
		pkg: "cli-windows-x64",
		goAsset: "supabase_windows_amd64.tar.gz",
		archive: `supabase_${version}_windows_amd64.zip`,
		ext: ".exe",
	},
];

const root = path.resolve(import.meta.dir, "../../..");

async function buildTarget(target: (typeof TARGETS)[number]) {
	const binDir = path.join(root, "packages", target.pkg, "bin");
	await mkdir(binDir, { recursive: true });

	const outfile = path.join(binDir, `supabase${target.ext}`);
	const entrypoint = path.join(root, "packages/cli/src/index.ts");

	console.log(`[${target.pkg}] Compiling Bun CLI...`);
	await $`bun build ${entrypoint} --compile --minify --target=${target.bunTarget} --outfile=${outfile}`;

	const assetUrl = `https://github.com/supabase/cli/releases/download/v${goVersion}/${target.goAsset}`;
	const sidecar = path.join(binDir, `supabase-backend${target.ext}`);

	console.log(`[${target.pkg}] Downloading Go CLI from ${assetUrl}...`);
	const response = await fetch(assetUrl);
	if (!response.ok) {
		throw new Error(
			`Failed to download ${assetUrl}: ${response.status} ${response.statusText}`,
		);
	}

	const buffer = await response.arrayBuffer();

	// Extract to a temp directory to avoid overwriting the compiled Bun binary
	const tmpDir = await mkdtemp(path.join(tmpdir(), "supabase-go-"));

	if (target.goAsset.endsWith(".zip")) {
		const tmpZip = path.join(tmpDir, "archive.zip");
		await Bun.write(tmpZip, buffer);
		await $`unzip -o ${tmpZip} -d ${tmpDir}`;
	} else {
		const tmpTar = path.join(tmpDir, "archive.tar.gz");
		await Bun.write(tmpTar, buffer);
		await $`tar -xzf ${tmpTar} -C ${tmpDir}`;
	}

	await $`mv ${path.join(tmpDir, `supabase${target.ext}`)} ${sidecar}`;
	await rm(tmpDir, { recursive: true });

	console.log(`[${target.pkg}] Done.`);
}

const distDir = path.join(root, "dist");

async function archiveTarget(target: (typeof TARGETS)[number]) {
	const binDir = path.join(root, "packages", target.pkg, "bin");
	const archivePath = path.join(distDir, target.archive);

	console.log(`[${target.pkg}] Creating archive ${target.archive}...`);

	if (target.archive.endsWith(".zip")) {
		await $`zip -j ${archivePath} ${path.join(binDir, `supabase${target.ext}`)} ${path.join(binDir, `supabase-backend${target.ext}`)}`;
	} else {
		await $`tar -czf ${archivePath} -C ${binDir} supabase${target.ext} supabase-backend${target.ext}`;
	}
}

async function buildMuslBinaries() {
	const muslDir = path.join(distDir, "musl");
	const entrypoint = path.join(root, "packages/cli/src/index.ts");

	await Promise.all(
		MUSL_TARGETS.map(async (target) => {
			const outDir = path.join(muslDir, target.nfpmArch);
			await mkdir(outDir, { recursive: true });

			const outfile = path.join(outDir, "supabase");
			console.log(`[musl-${target.nfpmArch}] Compiling Bun CLI (musl)...`);
			await $`bun build ${entrypoint} --compile --minify --target=${target.bunTarget} --outfile=${outfile}`;

			// Copy the Go backend from the glibc platform package (same binary works on both)
			const glibcPkg = target.nfpmArch === "arm64" ? "cli-linux-arm64" : "cli-linux-x64";
			const goBackend = path.join(root, "packages", glibcPkg, "bin", "supabase-backend");
			await $`cp ${goBackend} ${path.join(outDir, "supabase-backend")}`;

			console.log(`[musl-${target.nfpmArch}] Done.`);
		}),
	);
}

async function buildLinuxPackages(version: string) {
	const linuxTargets = TARGETS.filter((t) => "nfpmArch" in t);
	const jobs: Promise<void>[] = [];

	for (const target of linuxTargets) {
		const glibcBinDir = path.join(root, "packages", target.pkg, "bin");
		const muslBinDir = path.join(distDir, "musl", target.nfpmArch);

		for (const fmt of LINUX_PKG_FORMATS) {
			const outFile = `supabase_${version}_linux_${target.nfpmArch}.${fmt}`;
			const outPath = path.join(distDir, outFile);

			// apk targets Alpine (musl) — use musl-compiled Bun binary
			// deb/rpm target glibc distros — use glibc-compiled Bun binary
			const binDir = fmt === "apk" ? muslBinDir : glibcBinDir;

			const nfpmConfig: Record<string, unknown> = {
				name: "supabase",
				arch: target.nfpmArch,
				platform: "linux",
				version,
				maintainer: "Supabase <support@supabase.io>",
				description: "Supabase CLI",
				homepage: "https://supabase.com",
				license: "MIT",
				contents: [
					{ src: path.join(binDir, "supabase"), dst: "/usr/bin/supabase" },
					{
						src: path.join(binDir, "supabase-backend"),
						dst: "/usr/bin/supabase-backend",
					},
				],
			};

			// musl Bun binaries need libstdc++ and libgcc on Alpine
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

	// Hash archives
	for (const target of TARGETS) {
		const archivePath = path.join(distDir, target.archive);
		const data = await readFile(archivePath);
		const hash = createHash("sha256").update(data).digest("hex");
		lines.push(`${hash}  ${target.archive}`);
	}

	// Hash Linux packages
	const linuxTargets = TARGETS.filter((t) => "nfpmArch" in t);
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
	console.log(`Checksums written to dist/checksums.txt`);
}

console.log(`Building CLI for ${TARGETS.length} targets (Go CLI v${goVersion})...\n`);

// Build all targets concurrently
await Promise.all(TARGETS.map(buildTarget));

// Create distributable archives for brew/scoop
await mkdir(distDir, { recursive: true });
await Promise.all(TARGETS.map(archiveTarget));

// Build musl variants for Alpine apk packages
await buildMuslBinaries();

// Create Linux packages (.deb, .rpm use glibc; .apk uses musl)
await buildLinuxPackages(version);

await generateChecksums();

console.log("\nAll targets built successfully.");
