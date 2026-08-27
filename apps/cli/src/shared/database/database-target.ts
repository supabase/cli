type DatabaseTargetKind = "local" | "linked" | "url";

export type DatabaseTargetSelector =
  | { readonly kind: "local" }
  | { readonly kind: "linked" }
  | { readonly kind: "url"; readonly url: string };

export type DatabaseTarget = {
  readonly kind: DatabaseTargetKind;
  readonly identity: string;
  readonly connectionString: string;
  readonly disposable: boolean;
  readonly durable: boolean;
  readonly connectionVerified: boolean;
  readonly projectRef?: string;
  readonly connectionSource?: "env" | "flag";
};

export function envDatabaseUrl(): string | undefined {
  return process.env["SUPABASE_DB_URL"] ?? process.env["DATABASE_URL"];
}

export function envDatabaseUrlVarName(): "SUPABASE_DB_URL" | "DATABASE_URL" | undefined {
  if (process.env["SUPABASE_DB_URL"] !== undefined) return "SUPABASE_DB_URL";
  if (process.env["DATABASE_URL"] !== undefined) return "DATABASE_URL";
  return undefined;
}

export function parseTargetSelector(value: string): DatabaseTargetSelector {
  if (value === "local") return { kind: "local" };
  if (value === "linked") return { kind: "linked" };
  return { kind: "url", url: value };
}

export function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return "<unparseable-connection-string>";
  }
}
