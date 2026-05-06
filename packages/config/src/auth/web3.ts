import { Schema } from "effect";

const tags = ["auth"];

const defaultWeb3 = {};
const defaultProvider = {};
const defaultEnabled = false;

const provider = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable this Web3 provider.",
    tags,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnabled)),
}).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultProvider })));

export const web3 = Schema.Struct({
  solana: provider,
  ethereum: provider,
}).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultWeb3 })));
