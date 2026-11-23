import { describeContract } from "./cases.ts";
import { stackTarget } from "./target.ts";

describeContract("stack/native over api.tls, project pair", stackTarget("native", "custom"));
