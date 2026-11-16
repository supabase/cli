import { describeContract } from "./cases.ts";
import { stackTarget } from "./target.ts";

describeContract("stack/native", stackTarget("native"));
