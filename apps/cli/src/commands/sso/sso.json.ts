import { Schema } from "effect";

export const quoteSsoString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
