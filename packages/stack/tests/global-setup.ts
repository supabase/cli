export async function setup(): Promise<void> {
  const { prefetch } = await import("../src/bun.ts");
  try {
    const result = await prefetch();
    const summary = Object.entries(result)
      .map(([name, r]) => `${name}(${r.type})`)
      .join(", ");
    console.log("[global-setup] Services ready:", summary);
  } catch (error) {
    // Log but don't crash vitest — some services may fail to resolve.
    // E2E tests that need missing services will fail with a clear error at start time.
    console.warn("[global-setup] Prefetch failed:", String(error));
  }
}
