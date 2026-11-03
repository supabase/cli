import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  boolCodec,
  commaListCodec,
  globListCodec,
  literalCodec,
  portCodec,
  stringCodec,
  uintCodec,
} from "./cli-config-key.ts";

const codecs = [
  boolCodec,
  uintCodec,
  portCodec,
  commaListCodec,
  globListCodec,
  literalCodec(["a", "b"]),
  stringCodec,
];

const strings = [
  "0x10",
  "0X1F",
  "0b101",
  "0o17",
  "010",
  "08",
  "00",
  "0",
  "0_7",
  "0x_1f",
  "1_000",
  "1__0",
  "_1",
  "1_",
  "+1",
  "-0",
  "-1",
  "",
  "1",
  "65535",
  "65536",
  "065535",
  "0_1",
  "070000",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "18446744073709551616",
  "TRUE",
  "tRue",
  "True",
  "t",
  "F",
  "false",
  "0b",
  "0x",
  "abc",
  "a",
  "b",
  "a,b",
  "a, b",
  ",",
  "a,,b",
  " 1",
];

const documentValues: ReadonlyArray<unknown> = [
  0,
  1,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  -0,
  65535,
  65536,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  5n,
  true,
  false,
  null,
  undefined,
  {},
  { a: 1 },
  [],
  ["a", "b"],
  ["a", 1],
  [1, true],
  [{}],
  [[]],
  [["a"]],
  [null],
  1e21,
  1e-7,
  0.1,
  -1.5e-7,
];

const row = (input: unknown, decode: (codec: (typeof codecs)[number]) => unknown) =>
  [input, ...codecs.map(decode)].map((cell) => inspect(cell, { depth: 4 })).join(" | ");

describe("config codecs over an edge set", () => {
  it("parses env and flag text as before", () => {
    const table = strings.map((raw) => row(raw, (codec) => codec.parse(raw))).join("\n");

    expect(table).toBe(`'0x10' | undefined | 16 | 16 | [ '0x10' ] | [ '0x10' ] | undefined | '0x10'
'0X1F' | undefined | 31 | 31 | [ '0X1F' ] | [ '0X1F' ] | undefined | '0X1F'
'0b101' | undefined | 5 | 5 | [ '0b101' ] | [ '0b101' ] | undefined | '0b101'
'0o17' | undefined | 15 | 15 | [ '0o17' ] | [ '0o17' ] | undefined | '0o17'
'010' | undefined | 8 | undefined | [ '010' ] | [ '010' ] | undefined | '010'
'08' | undefined | undefined | undefined | [ '08' ] | [ '08' ] | undefined | '08'
'00' | undefined | 0 | undefined | [ '00' ] | [ '00' ] | undefined | '00'
'0' | false | 0 | 0 | [ '0' ] | [ '0' ] | undefined | '0'
'0_7' | undefined | 7 | undefined | [ '0_7' ] | [ '0_7' ] | undefined | '0_7'
'0x_1f' | undefined | 31 | 31 | [ '0x_1f' ] | [ '0x_1f' ] | undefined | '0x_1f'
'1_000' | undefined | 1000 | 1000 | [ '1_000' ] | [ '1_000' ] | undefined | '1_000'
'1__0' | undefined | undefined | undefined | [ '1__0' ] | [ '1__0' ] | undefined | '1__0'
'_1' | undefined | undefined | undefined | [ '_1' ] | [ '_1' ] | undefined | '_1'
'1_' | undefined | undefined | undefined | [ '1_' ] | [ '1_' ] | undefined | '1_'
'+1' | undefined | undefined | undefined | [ '+1' ] | [ '+1' ] | undefined | '+1'
'-0' | undefined | undefined | undefined | [ '-0' ] | [ '-0' ] | undefined | '-0'
'-1' | undefined | undefined | undefined | [ '-1' ] | [ '-1' ] | undefined | '-1'
'' | false | undefined | undefined | [] | [] | undefined | ''
'1' | true | 1 | 1 | [ '1' ] | [ '1' ] | undefined | '1'
'65535' | undefined | 65535 | 65535 | [ '65535' ] | [ '65535' ] | undefined | '65535'
'65536' | undefined | 65536 | undefined | [ '65536' ] | [ '65536' ] | undefined | '65536'
'065535' | undefined | 27485 | undefined | [ '065535' ] | [ '065535' ] | undefined | '065535'
'0_1' | undefined | 1 | undefined | [ '0_1' ] | [ '0_1' ] | undefined | '0_1'
'070000' | undefined | 28672 | undefined | [ '070000' ] | [ '070000' ] | undefined | '070000'
'9007199254740991' | undefined | 9007199254740991 | undefined | [ '9007199254740991' ] | [ '9007199254740991' ] | undefined | '9007199254740991'
'9007199254740992' | undefined | undefined | undefined | [ '9007199254740992' ] | [ '9007199254740992' ] | undefined | '9007199254740992'
'9007199254740993' | undefined | undefined | undefined | [ '9007199254740993' ] | [ '9007199254740993' ] | undefined | '9007199254740993'
'18446744073709551616' | undefined | undefined | undefined | [ '18446744073709551616' ] | [ '18446744073709551616' ] | undefined | '18446744073709551616'
'TRUE' | true | undefined | undefined | [ 'TRUE' ] | [ 'TRUE' ] | undefined | 'TRUE'
'tRue' | undefined | undefined | undefined | [ 'tRue' ] | [ 'tRue' ] | undefined | 'tRue'
'True' | true | undefined | undefined | [ 'True' ] | [ 'True' ] | undefined | 'True'
't' | true | undefined | undefined | [ 't' ] | [ 't' ] | undefined | 't'
'F' | false | undefined | undefined | [ 'F' ] | [ 'F' ] | undefined | 'F'
'false' | false | undefined | undefined | [ 'false' ] | [ 'false' ] | undefined | 'false'
'0b' | undefined | undefined | undefined | [ '0b' ] | [ '0b' ] | undefined | '0b'
'0x' | undefined | undefined | undefined | [ '0x' ] | [ '0x' ] | undefined | '0x'
'abc' | undefined | undefined | undefined | [ 'abc' ] | [ 'abc' ] | undefined | 'abc'
'a' | undefined | undefined | undefined | [ 'a' ] | [ 'a' ] | 'a' | 'a'
'b' | undefined | undefined | undefined | [ 'b' ] | [ 'b' ] | 'b' | 'b'
'a,b' | undefined | undefined | undefined | [ 'a', 'b' ] | [ 'a', 'b' ] | undefined | 'a,b'
'a, b' | undefined | undefined | undefined | [ 'a', ' b' ] | [ 'a', ' b' ] | undefined | 'a, b'
',' | undefined | undefined | undefined | [ '', '' ] | [ '', '' ] | undefined | ','
'a,,b' | undefined | undefined | undefined | [ 'a', '', 'b' ] | [ 'a', '', 'b' ] | undefined | 'a,,b'
' 1' | undefined | undefined | undefined | [ ' 1' ] | [ ' 1' ] | undefined | ' 1'`);
  });

  it("decodes document values as before", () => {
    const table = [...strings, ...documentValues]
      .map((value) => row(value, (codec) => codec.fromConfig(value)))
      .join("\n");

    expect(table).toBe(`'0x10' | undefined | 16 | 16 | [ '0x10' ] | [ '0x10' ] | undefined | '0x10'
'0X1F' | undefined | 31 | 31 | [ '0X1F' ] | [ '0X1F' ] | undefined | '0X1F'
'0b101' | undefined | 5 | 5 | [ '0b101' ] | [ '0b101' ] | undefined | '0b101'
'0o17' | undefined | 15 | 15 | [ '0o17' ] | [ '0o17' ] | undefined | '0o17'
'010' | undefined | 8 | undefined | [ '010' ] | [ '010' ] | undefined | '010'
'08' | undefined | undefined | undefined | [ '08' ] | [ '08' ] | undefined | '08'
'00' | undefined | 0 | undefined | [ '00' ] | [ '00' ] | undefined | '00'
'0' | false | 0 | 0 | [ '0' ] | [ '0' ] | undefined | '0'
'0_7' | undefined | 7 | undefined | [ '0_7' ] | [ '0_7' ] | undefined | '0_7'
'0x_1f' | undefined | 31 | 31 | [ '0x_1f' ] | [ '0x_1f' ] | undefined | '0x_1f'
'1_000' | undefined | 1000 | 1000 | [ '1_000' ] | [ '1_000' ] | undefined | '1_000'
'1__0' | undefined | undefined | undefined | [ '1__0' ] | [ '1__0' ] | undefined | '1__0'
'_1' | undefined | undefined | undefined | [ '_1' ] | [ '_1' ] | undefined | '_1'
'1_' | undefined | undefined | undefined | [ '1_' ] | [ '1_' ] | undefined | '1_'
'+1' | undefined | undefined | undefined | [ '+1' ] | [ '+1' ] | undefined | '+1'
'-0' | undefined | undefined | undefined | [ '-0' ] | [ '-0' ] | undefined | '-0'
'-1' | undefined | undefined | undefined | [ '-1' ] | [ '-1' ] | undefined | '-1'
'' | false | undefined | undefined | [] | [] | undefined | ''
'1' | true | 1 | 1 | [ '1' ] | [ '1' ] | undefined | '1'
'65535' | undefined | 65535 | 65535 | [ '65535' ] | [ '65535' ] | undefined | '65535'
'65536' | undefined | 65536 | undefined | [ '65536' ] | [ '65536' ] | undefined | '65536'
'065535' | undefined | 27485 | undefined | [ '065535' ] | [ '065535' ] | undefined | '065535'
'0_1' | undefined | 1 | undefined | [ '0_1' ] | [ '0_1' ] | undefined | '0_1'
'070000' | undefined | 28672 | undefined | [ '070000' ] | [ '070000' ] | undefined | '070000'
'9007199254740991' | undefined | 9007199254740991 | undefined | [ '9007199254740991' ] | [ '9007199254740991' ] | undefined | '9007199254740991'
'9007199254740992' | undefined | undefined | undefined | [ '9007199254740992' ] | [ '9007199254740992' ] | undefined | '9007199254740992'
'9007199254740993' | undefined | undefined | undefined | [ '9007199254740993' ] | [ '9007199254740993' ] | undefined | '9007199254740993'
'18446744073709551616' | undefined | undefined | undefined | [ '18446744073709551616' ] | [ '18446744073709551616' ] | undefined | '18446744073709551616'
'TRUE' | true | undefined | undefined | [ 'TRUE' ] | [ 'TRUE' ] | undefined | 'TRUE'
'tRue' | undefined | undefined | undefined | [ 'tRue' ] | [ 'tRue' ] | undefined | 'tRue'
'True' | true | undefined | undefined | [ 'True' ] | [ 'True' ] | undefined | 'True'
't' | true | undefined | undefined | [ 't' ] | [ 't' ] | undefined | 't'
'F' | false | undefined | undefined | [ 'F' ] | [ 'F' ] | undefined | 'F'
'false' | false | undefined | undefined | [ 'false' ] | [ 'false' ] | undefined | 'false'
'0b' | undefined | undefined | undefined | [ '0b' ] | [ '0b' ] | undefined | '0b'
'0x' | undefined | undefined | undefined | [ '0x' ] | [ '0x' ] | undefined | '0x'
'abc' | undefined | undefined | undefined | [ 'abc' ] | [ 'abc' ] | undefined | 'abc'
'a' | undefined | undefined | undefined | [ 'a' ] | [ 'a' ] | 'a' | 'a'
'b' | undefined | undefined | undefined | [ 'b' ] | [ 'b' ] | 'b' | 'b'
'a,b' | undefined | undefined | undefined | [ 'a', 'b' ] | [ 'a', 'b' ] | undefined | 'a,b'
'a, b' | undefined | undefined | undefined | [ 'a', ' b' ] | [ 'a', ' b' ] | undefined | 'a, b'
',' | undefined | undefined | undefined | [ '', '' ] | [ '', '' ] | undefined | ','
'a,,b' | undefined | undefined | undefined | [ 'a', '', 'b' ] | [ 'a', '', 'b' ] | undefined | 'a,,b'
' 1' | undefined | undefined | undefined | [ ' 1' ] | [ ' 1' ] | undefined | ' 1'
0 | false | 0 | 0 | undefined | [ '0' ] | undefined | undefined
1 | true | 1 | 1 | undefined | [ '1' ] | undefined | undefined
-1 | true | undefined | undefined | undefined | [ '-1' ] | undefined | undefined
1.5 | true | undefined | undefined | undefined | [ '1.5' ] | undefined | undefined
NaN | true | undefined | undefined | undefined | [ 'NaN' ] | undefined | undefined
Infinity | true | undefined | undefined | undefined | [ '+Inf' ] | undefined | undefined
-0 | false | -0 | -0 | undefined | [ '-0' ] | undefined | undefined
65535 | true | 65535 | 65535 | undefined | [ '65535' ] | undefined | undefined
65536 | true | 65536 | undefined | undefined | [ '65536' ] | undefined | undefined
9007199254740991 | true | 9007199254740991 | undefined | undefined | [ '9007199254740991' ] | undefined | undefined
9007199254740992 | true | undefined | undefined | undefined | [ '9007199254740992' ] | undefined | undefined
5n | undefined | undefined | undefined | undefined | [ '5' ] | undefined | undefined
true | true | undefined | undefined | undefined | [ '1' ] | undefined | undefined
false | false | undefined | undefined | undefined | [ '0' ] | undefined | undefined
null | undefined | undefined | undefined | undefined | undefined | undefined | undefined
undefined | undefined | undefined | undefined | undefined | undefined | undefined | undefined
{} | undefined | undefined | undefined | undefined | [] | undefined | undefined
{ a: 1 } | undefined | undefined | undefined | undefined | undefined | undefined | undefined
[] | undefined | undefined | undefined | [] | [] | undefined | undefined
[ 'a', 'b' ] | undefined | undefined | undefined | [ 'a', 'b' ] | [ 'a', 'b' ] | undefined | undefined
[ 'a', 1 ] | undefined | undefined | undefined | undefined | [ 'a', '1' ] | undefined | undefined
[ 1, true ] | undefined | undefined | undefined | undefined | [ '1', '1' ] | undefined | undefined
[ {} ] | undefined | undefined | undefined | undefined | undefined | undefined | undefined
[ [] ] | undefined | undefined | undefined | undefined | undefined | undefined | undefined
[ [ 'a' ] ] | undefined | undefined | undefined | undefined | undefined | undefined | undefined
[ null ] | undefined | undefined | undefined | undefined | undefined | undefined | undefined
1e+21 | true | undefined | undefined | undefined | [ '1000000000000000000000' ] | undefined | undefined
1e-7 | true | undefined | undefined | undefined | [ '0.0000001' ] | undefined | undefined
0.1 | true | undefined | undefined | undefined | [ '0.1' ] | undefined | undefined
-1.5e-7 | true | undefined | undefined | undefined | [ '-0.00000015' ] | undefined | undefined`);
  });
});
