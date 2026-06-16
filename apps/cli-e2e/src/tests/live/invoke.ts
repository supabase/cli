import { expect } from "vitest";

export interface InvokeResult {
  status: number;
  body: unknown;
  text: string;
}

/** Direct HTTP-invoke a deployed Edge Function and return status + parsed body.
 *  The replay server is not involved (ADR-0013) — this is a real call to the
 *  deployed function. Staging expects the publishable/anon key in BOTH the
 *  Authorization Bearer header and the apikey header. */
export async function invokeFunction(opts: {
  functionsUrl: string;
  slug: string;
  anonKey?: string;
  payload?: unknown;
}): Promise<InvokeResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.anonKey) {
    headers["Authorization"] = `Bearer ${opts.anonKey}`;
    headers["apikey"] = opts.anonKey;
  }
  const res = await fetch(`${opts.functionsUrl}/${opts.slug}`, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.payload ?? {}),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

/** Assert the playbook's default per-slug expectation: 200 + `{case: slug, ok: true}`. */
export function expectFunctionOk(
  result: InvokeResult,
  slug: string,
  extra?: Record<string, unknown>,
): void {
  expect(result.status, result.text).toBe(200);
  expect(result.body).toMatchObject({ case: slug, ok: true, ...extra });
}
