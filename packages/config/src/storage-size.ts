export class InvalidStorageSizeError extends Error {
  constructor() {
    super("invalid size");
    this.name = "InvalidStorageSizeError";
  }
}

const multipliers: Readonly<Record<string, number>> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
};

function invalidSize(): InvalidStorageSizeError {
  return new InvalidStorageSizeError();
}

/** Parses the Docker/Go RAM-size grammar used by local Storage configuration. */
export function parseStorageSizeBytes(input: string): number {
  let separator = -1;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== undefined && "0123456789. ".includes(character)) separator = index;
  }
  if (separator === -1) throw invalidSize();

  const numeric =
    input[separator] === " " ? input.slice(0, separator) : input.slice(0, separator + 1);
  let suffix = input.slice(separator + 1);
  if (
    !/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)([eE][+-]?\d(?:_?\d)*)?$/.test(
      numeric,
    )
  ) {
    throw invalidSize();
  }
  const size = Number.parseFloat(numeric.replaceAll("_", ""));
  if (!Number.isFinite(size) || size < 0) throw invalidSize();
  if (suffix.length === 0) return Math.trunc(size);
  if (suffix.length > 3) throw invalidSize();

  suffix = suffix.toLowerCase();
  if (suffix[0] === "b") {
    if (suffix.length !== 1) throw invalidSize();
    return Math.trunc(size);
  }
  const multiplier = multipliers[suffix[0] ?? ""];
  if (multiplier === undefined) throw invalidSize();
  if (suffix.length === 2 && suffix[1] !== "b") throw invalidSize();
  if (suffix.length === 3 && suffix.slice(1) !== "ib") throw invalidSize();
  return Math.trunc(size * multiplier);
}
