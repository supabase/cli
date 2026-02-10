import * as s from "jsonv-ts";

interface IEnvOptions extends s.IStringOptions {
  secret?: true;
}

class EnvSchema<O extends IEnvOptions> extends s.StringSchema<O> {
  override toJSON() {
    const { secret, ...json } = super.toJSON();
    return {
      ...json,
      ...(secret && { "x-secret": true }),
      pattern: "^env\\([A-Z_][A-Z0-9_]*\\)$",
    };
  }
}

export const env = <O extends IEnvOptions>(o?: O): EnvSchema<O> & O => new EnvSchema(o) as any;
