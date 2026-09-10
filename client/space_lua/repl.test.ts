import { expect, test } from "vitest";
import { evalLuaRepl } from "./repl.ts";
import { LuaEnv, LuaNativeJSFunction } from "./runtime.ts";

test("REPL expressions return their value", async () => {
  const env = new LuaEnv();

  await expect(evalLuaRepl("1 + 2", env)).resolves.toEqual(3);
});

test("REPL expressions allow multiline input and trailing comments", async () => {
  const env = new LuaEnv();

  await expect(evalLuaRepl("(1 +\n  2) -- fixture note", env)).resolves.toEqual(
    3,
  );
});

test("REPL statements execute as a block", async () => {
  const env = new LuaEnv();

  await expect(evalLuaRepl("answer = 6 * 7", env)).resolves.toBeNull();
  expect(env.get("answer")).toEqual(42);
});

test("an expression execution error is never retried as a statement", async () => {
  const env = new LuaEnv();
  let calls = 0;
  env.set(
    "failAfterSideEffect",
    new LuaNativeJSFunction(() => {
      calls++;
      throw new Error("fixture failure");
    }),
  );

  await expect(evalLuaRepl("failAfterSideEffect()", env)).rejects.toThrow(
    "fixture failure",
  );
  expect(calls).toEqual(1);
});

test("invalid REPL input does not execute its valid prefix", async () => {
  const env = new LuaEnv();
  let calls = 0;
  env.set(
    "record",
    new LuaNativeJSFunction(() => {
      calls++;
    }),
  );

  await expect(evalLuaRepl("record() )", env)).rejects.toThrow();
  expect(calls).toEqual(0);
});

test("namespace members retain function signatures without invoking them", async () => {
  const env = new LuaEnv();
  await evalLuaRepl(
    'catalog = {count = 3, lookup = function(name) error("must not run") end}',
    env,
  );
  const result = await evalLuaRepl("catalog", env);
  expect(result).toEqual({
    count: 3,
    lookup: expect.stringContaining("lookup(name)"),
  });
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  await evalLuaRepl("alias = catalog", env);
  expect(await evalLuaRepl("alias", env)).toEqual(result);
  await evalLuaRepl("catalog = {count = 9}", env);
  expect(await evalLuaRepl("catalog", env)).toEqual({ count: 9 });
});

test("function results show documentation and parameters", async () => {
  const env = new LuaEnv();
  await evalLuaRepl("function lookup(name) return name end", env);
  expect(await evalLuaRepl("lookup", env)).toContain("lookup(name)");
});

test("nested functions survive JSON and cycles are explicit", async () => {
  const env = new LuaEnv();
  await evalLuaRepl(
    "record = {nested = {run = function() end}}; record.self = record",
    env,
  );
  expect(await evalLuaRepl("record", env)).toEqual({
    nested: { run: expect.stringContaining("run()") },
    self: "[circular table]",
  });
});
