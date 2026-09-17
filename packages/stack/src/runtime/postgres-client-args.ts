export const POSTGRES_DUMP_BINS = ["pg_dump", "pg_dumpall", "psql"] as const;
export const POSTGRES_PROVE_BINS = ["pg_prove"] as const;
export const POSTGRES_CLIENT_BINS = [...POSTGRES_DUMP_BINS, ...POSTGRES_PROVE_BINS] as const;

/** Dump scripts need pg_dump/psql; `pg_prove` is required only when that is the argv. */
export const requiredPostgresClientBins = (
  argv: ReadonlyArray<string>,
): ReadonlyArray<(typeof POSTGRES_CLIENT_BINS)[number]> =>
  argv[0] === "pg_prove" ? POSTGRES_PROVE_BINS : POSTGRES_DUMP_BINS;

export interface PostgresClientMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export const nativePostgresClientEnv = (
  binDir: string,
  env: Readonly<Record<string, string>>,
  pathValue: string | undefined,
  delimiter: string,
): Record<string, string> => ({
  ...env,
  PATH:
    pathValue === undefined || pathValue.length === 0
      ? binDir
      : `${binDir}${delimiter}${pathValue}`,
});

export const postgresClientContainerArgs = (opts: {
  readonly image: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly mounts?: ReadonlyArray<PostgresClientMount>;
  readonly network?: "host" | { readonly name: string };
  readonly extraHosts?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly securityOpt?: ReadonlyArray<string>;
}): ReadonlyArray<string> => {
  const networkArgs =
    opts.network === undefined
      ? []
      : opts.network === "host"
        ? ["--network", "host"]
        : ["--network", opts.network.name];
  return [
    "run",
    "--rm",
    ...networkArgs,
    ...(opts.extraHosts ?? []).flatMap((host) => ["--add-host", host]),
    ...(opts.mounts ?? []).flatMap((mount) => [
      "-v",
      `${mount.source}:${mount.target}${mount.readOnly === true ? ":ro" : ""}`,
    ]),
    ...Object.keys(opts.env).flatMap((key) => ["-e", key]),
    ...(opts.securityOpt ?? []).flatMap((opt) => ["--security-opt", opt]),
    ...(opts.cwd === undefined ? [] : ["-w", opts.cwd]),
    opts.image,
    ...opts.argv,
  ];
};
