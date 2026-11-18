import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { API, type Checker, SymbolFlags } from "typescript/unstable/async";

function* nodes(root: ts.Node): Generator<ts.Node> {
  yield root;
  const children: ts.Node[] = [];
  root.forEachChild((child) => {
    children.push(child);
  });
  for (const child of children) yield* nodes(child);
}

const declaration = Effect.fnUntraced(function* (checker: Checker, ref: ts.Node) {
  const symbol = yield* Effect.promise(() => checker.getSymbolAtLocation(ref));
  if (!symbol) return undefined;
  const target =
    symbol.flags & SymbolFlags.Alias
      ? yield* Effect.promise(() => checker.getAliasedSymbol(symbol))
      : symbol;
  const handle = target.valueDeclaration;
  return handle && (yield* Effect.promise(() => handle.resolve()));
});

const policy = Effect.fnUntraced(function* (checker: Checker, member: ts.PropertyAccessExpression) {
  const decl = yield* declaration(checker, member.expression);
  if (
    decl &&
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isCallExpression(decl.initializer) &&
    decl.initializer.expression.getText() === "defineExperimentalAccess"
  ) {
    return `${decl.getSourceFile().fileName.split("/src/").pop()}:${decl.name.getText()}`;
  }
  return undefined;
});

function checksIn(
  handler: ts.Node,
  checker: Checker,
  checks: Set<string>,
  followHandler: boolean,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const node of nodes(handler)) {
      if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) {
        const member = ts.isCallExpression(node.expression)
          ? node.expression.expression
          : node.expression;
        if (ts.isPropertyAccessExpression(member) && member.name.getText() === "check") {
          const key = yield* policy(checker, member);
          if (key) checks.add(key);
        }
      }
      if (followHandler && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const decl = yield* declaration(checker, node.expression);
        if (decl?.getSourceFile().fileName.endsWith(".handler.ts"))
          yield* checksIn(decl, checker, checks, false);
      }
    }
  });
}

it.effect(
  "pairs each command's experimental annotations with checks in its own handler",
  Effect.fn("ExperimentalAccess.inspectPairing")(function* () {
    const config = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
    const api = yield* Effect.acquireRelease(
      Effect.sync(() => new API()),
      (api) => Effect.promise(() => api.close()),
    );
    const snapshot = yield* Effect.promise(() => api.updateSnapshot({ openProjects: [config] }));
    const project = snapshot.getProject(config)!;
    const files = project.rootFiles.filter((file) => file.endsWith(".command.ts"));
    expect(files.length).toBeGreaterThan(0);
    const failures: string[] = [];
    const recognizedPolicies = new Set<string>();
    for (const file of files) {
      const source = (yield* Effect.promise(() => project.program.getSourceFile(file)))!;
      for (const pipe of nodes(source)) {
        if (
          !ts.isCallExpression(pipe) ||
          !ts.isPropertyAccessExpression(pipe.expression) ||
          pipe.expression.name.getText() !== "pipe"
        )
          continue;
        const annotated = new Set<string>();
        const checked = new Set<string>();
        for (const arg of pipe.arguments) {
          if (ts.isPropertyAccessExpression(arg) && arg.name.getText() === "annotate") {
            const key = yield* policy(project.checker, arg);
            if (key) annotated.add(key);
          }
          if (
            ts.isCallExpression(arg) &&
            arg.expression.getText() === "Command.withHandler" &&
            arg.arguments[0]
          ) {
            yield* checksIn(arg.arguments[0], project.checker, checked, true);
          }
        }
        for (const key of new Set([...annotated, ...checked])) {
          recognizedPolicies.add(key);
          if (annotated.has(key) !== checked.has(key))
            failures.push(
              `${file}: missing ${annotated.has(key) ? "check" : "annotation"} for ${key}`,
            );
        }
      }
    }
    expect(failures).toEqual([]);
    expect(
      recognizedPolicies.size,
      "Recognized experimental policies in the command scan",
    ).toBeGreaterThan(0);
  }),
);
