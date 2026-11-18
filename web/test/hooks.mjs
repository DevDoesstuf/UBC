// Module hooks for `npm test`: lets Node's built-in TypeScript stripping run the app's lib/ code as-is.
//  - "@/x" resolves to <web>/x (the tsconfig path alias)
//  - extensionless relative imports try .ts, then /index.ts (Next's bundler resolution)
//  - .json files load as an ES module with a default export (no import attributes needed)
//  - "next/server" resolves to next/server.js (so route handlers can be called in tests)
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);

function tryFile(url) {
  const p = fileURLToPath(url);
  for (const cand of [p, `${p}.ts`, `${p}/index.ts`]) {
    if (existsSync(cand) && !cand.endsWith("/")) {
      try {
        readFileSync(cand);
        return pathToFileURL(cand).href;
      } catch {
        /* directory */
      }
    }
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const hit = tryFile(new URL(specifier.slice(2), ROOT));
    if (hit) return { url: hit, shortCircuit: true };
  }
  // Route handlers import "next/server"; Next ships it as CommonJS without an exports map, so name the file.
  if (specifier === "next/server") return next("next/server.js", context);
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const hit = tryFile(new URL(specifier, context.parentURL));
    if (hit) return { url: hit, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".json")) {
    const text = readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", source: `export default ${text};`, shortCircuit: true };
  }
  return next(url, context);
}
