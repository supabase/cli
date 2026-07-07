const DEFAULT_POSTGRES_PASSWORD = "postgres";

export const resolvePostgresPassword = (password?: string): string =>
  password ?? process.env.POSTGRES_PASSWORD ?? DEFAULT_POSTGRES_PASSWORD;

export const postgresConnectionUrl = (opts: {
  readonly scheme?: "postgresql" | "ecto";
  readonly user: string;
  readonly password: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
}): string =>
  `${opts.scheme ?? "postgresql"}://${opts.user}:${encodeURIComponent(opts.password)}@${opts.host}:${opts.port}/${opts.database}`;
