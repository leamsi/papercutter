import type { LuaFunctionInfo } from "../../plug-api/types/index.ts";
import { evalStatement } from "./eval.ts";
import { parseBlock } from "./parse.ts";
import {
  LuaEnv,
  LuaStackFrame,
  LuaTable,
  isILuaFunction,
  luaValueToJS,
} from "./runtime.ts";
import {
  functionSignature,
  renderApiDocumentationMarkdown,
} from "./api_documentation.ts";

async function displayValue(
  value: unknown,
  sf: LuaStackFrame,
  name?: string,
  ancestors = new Set<unknown>(),
): Promise<unknown> {
  value = await value;
  if (isILuaFunction(value)) {
    const info: LuaFunctionInfo = {
      ...value.info,
      kind: value.info?.kind ?? "builtin",
      name: value.info?.name ?? name ?? "<anonymous>",
    };
    if (ancestors.size === 0) return renderApiDocumentationMarkdown([info]);
    const signature = info.signatures?.join(" / ") || functionSignature(info);
    const returns = info.returns
      ?.map((result) => result.type ?? "unknown")
      .join(", ");
    const summary = info.description
      ?.split("\n\n")[0]
      .replace(/\s+/g, " ")
      .trim();
    return `${signature}${returns ? ` → ${returns}` : ""}${summary ? ` — ${summary}` : ""}`;
  }
  if (value instanceof LuaTable || value instanceof LuaEnv) {
    if (ancestors.has(value)) return "[circular table]";
    if (ancestors.size >= 32) return "[table depth limit]";
    ancestors.add(value);
    try {
      if (value instanceof LuaTable && value.length > 0) {
        const result = [];
        for (let i = 1; i <= value.rawLength; i++) {
          result.push(
            await displayValue(value.rawGet(i), sf, String(i), ancestors),
          );
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key of value.keys()) {
        const child =
          value instanceof LuaTable ? value.rawGet(key) : value.get(key);
        result[String(key)] = await displayValue(
          child,
          sf,
          String(key),
          ancestors,
        );
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  return (await luaValueToJS(value, sf)) ?? null;
}

export async function evalLuaRepl(
  code: string,
  globalEnv: LuaEnv,
): Promise<unknown> {
  let ast;
  try {
    ast = parseBlock(`return ${code}\n`);
  } catch {
    ast = parseBlock(code);
  }
  const scriptEnv = new LuaEnv(globalEnv);
  const threadEnv = new LuaEnv();
  threadEnv.setLocal("_GLOBAL", globalEnv);
  const sf = new LuaStackFrame(threadEnv, ast.ctx);
  const result = await evalStatement(ast, scriptEnv, sf);
  const returnValue =
    result &&
    typeof result === "object" &&
    "ctrl" in result &&
    result.ctrl === "return" &&
    Array.isArray(result.values)
      ? result.values[0]
      : result;
  return displayValue(returnValue, sf);
}
