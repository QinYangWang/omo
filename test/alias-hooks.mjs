import path from "node:path";
import { pathToFileURL } from "node:url";

const srcRoot = path.resolve(import.meta.dirname, "../src");

// Map the app's "@/..." import alias onto src/ so node --test can load the
// TypeScript modules directly (type stripping handles the rest).
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) {
    return nextResolve(specifier, context);
  }
  const base = path.join(srcRoot, specifier.slice(2));
  const candidates = [base, `${base}.ts`, `${base}.tsx`];
  const results = await Promise.all(
    candidates.map((candidate) =>
      nextResolve(pathToFileURL(candidate).href, context).then(
        (result) => result,
        () => null
      )
    )
  );
  const hit = results.find(Boolean);
  if (hit) {
    return hit;
  }
  return nextResolve(specifier, context);
}
