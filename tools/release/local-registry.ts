/**
 * Starts a local Verdaccio npm registry for testing CLI releases.
 *
 * Usage: pnpm local-registry
 *
 * - Starts Verdaccio on http://localhost:4873
 * - Creates a local publish user and stores the auth token in tmp/verdaccio-token
 * - Redirects the global npm and pnpm registry config to the local registry
 * - Restores the original registry config and kills Verdaccio on Ctrl+C / SIGTERM
 */

import { $ } from "bun";
import { openSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = 4873;
const REGISTRY = `http://localhost:${PORT}`;
const LOCAL_USER = "local-dev";
const LOCAL_PASS = "local-dev-password";

const root = path.resolve(import.meta.dir, "../..");
const tmpDir = path.join(root, "tmp", "verdaccio");
const configPath = path.join(root, "tmp", "verdaccio.yaml");
const tokenPath = path.join(root, "tmp", "verdaccio-token");
const logPath = path.join(root, "tmp", "verdaccio.log");

async function isPortInUse(): Promise<boolean> {
	try {
		const res = await fetch(`${REGISTRY}/-/ping`, {
			signal: AbortSignal.timeout(1000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function waitForRegistry(maxAttempts = 30, intervalMs = 500): Promise<void> {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const res = await fetch(`${REGISTRY}/-/ping`, {
				signal: AbortSignal.timeout(1000),
			});
			if (res.ok) return;
		} catch {
			// not ready yet
		}
		await Bun.sleep(intervalMs);
	}
	const totalSeconds = (maxAttempts * intervalMs) / 1000;
	throw new Error(
		`Verdaccio did not become ready within ${totalSeconds}s. Check logs: ${logPath}`,
	);
}

async function createUser(): Promise<string> {
	const res = await fetch(`${REGISTRY}/-/user/org.couchdb.user:${LOCAL_USER}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: LOCAL_USER,
			password: LOCAL_PASS,
			email: "local@local.dev",
			_id: `org.couchdb.user:${LOCAL_USER}`,
			type: "user",
			roles: [],
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to create Verdaccio user (HTTP ${res.status}): ${body}`);
	}

	const body = (await res.json()) as { token?: string };
	if (!body.token) {
		throw new Error("Verdaccio did not return an auth token after user creation.");
	}
	return body.token;
}

async function getRegistryConfig(tool: "npm" | "pnpm"): Promise<string> {
	try {
		const value = (await $`${tool} config get registry`.quiet().text()).trim();
		return value === "undefined" ? "https://registry.npmjs.org/" : value;
	} catch {
		return "https://registry.npmjs.org/";
	}
}

async function main() {
	if (await isPortInUse()) {
		console.error(`\nError: Something is already running on port ${PORT}.`);
		console.error(
			"If it's a leftover Verdaccio process, kill it first and retry.\n",
		);
		process.exit(1);
	}

	// Fresh storage each run to avoid stale auth or package conflicts.
	await rm(tmpDir, { recursive: true, force: true });
	await mkdir(tmpDir, { recursive: true });

	// Resolve {root} placeholder in the config template.
	const template = await Bun.file(path.join(root, "verdaccio.yaml")).text();
	const resolved = template.replaceAll("{root}", root);
	await writeFile(configPath, resolved, "utf-8");

	// Start Verdaccio, piping output to a log file.
	const logFd = openSync(logPath, "w");
	const verdaccioBin = path.join(root, "node_modules", ".bin", "verdaccio");
	const proc = Bun.spawn([verdaccioBin, "--config", configPath], {
		cwd: root,
		stdout: logFd,
		stderr: logFd,
	});

	// Handle unexpected Verdaccio crash.
	proc.exited.then((code) => {
		if (code !== 0 && code !== null) {
			console.error(
				`\nVerdaccio exited unexpectedly (code ${code}). Check logs: ${logPath}\n`,
			);
			process.exit(1);
		}
	});

	process.stdout.write(`Starting local registry at ${REGISTRY}...`);
	await waitForRegistry();
	process.stdout.write(" ready.\n");

	// Create a publish user and persist the token so local-release.ts can use it.
	const token = await createUser();
	await writeFile(tokenPath, token, "utf-8");

	// Capture current global registry settings so we can restore them on exit.
	const origNpm = await getRegistryConfig("npm");
	const origPnpm = await getRegistryConfig("pnpm");

	await $`npm config set registry ${REGISTRY}`.quiet();
	await $`pnpm config set registry ${REGISTRY}`.quiet();

	console.log(`
  Registry : ${REGISTRY}
  Token    : ${tokenPath}
  Logs     : ${logPath}

  Publish the CLI in another terminal:
    pnpm cli-release --next
    pnpm cli-release --legacy

  Press Ctrl+C to stop and restore the original registry settings.
`);

	const cleanup = async () => {
		process.stdout.write("\nShutting down local registry...");
		try {
			await $`npm config set registry ${origNpm}`.quiet();
			await $`pnpm config set registry ${origPnpm}`.quiet();
			process.stdout.write(" registry restored.\n");
		} catch {
			process.stdout.write(
				"\nWarning: could not restore registry config — run:\n" +
					`  npm config set registry ${origNpm}\n` +
					`  pnpm config set registry ${origPnpm}\n`,
			);
		}
		proc.kill();
		process.exit(0);
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	// Block until a signal is received.
	await new Promise<never>(() => {});
}

await main();
