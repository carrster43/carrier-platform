/**
 * Lets Node resolve the extensionless relative imports the app source uses.
 *
 * `lib/letter.ts` imports "./detect", which Metro and tsc both resolve happily
 * and Node ESM does not. The alternative was to add `.ts` extensions across the
 * app source so a test could run, which is the tail wagging the dog: the test
 * exists to check the shipped code, so the shipped code should not be reshaped
 * to suit it.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".") && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        const candidate = new URL(base.href + ext);
        if (existsSync(fileURLToPath(candidate))) {
          // "module-typescript", not "module". Returning plain "module" tells
          // Node the file is already JavaScript, so --experimental-strip-types
          // never runs on it and the first `export type` throws SyntaxError.
          // Nothing hit this until lib/nearby.ts imported lib/porches.ts: the
          // resolver had only ever been exercised on imports the test files
          // wrote with an explicit .ts extension, which take the `next()` path
          // above and get stripped correctly. A lib importing a lib is the
          // first time the fallback carries TypeScript.
          const format = /\.tsx?$/.test(candidate.pathname) ? "module-typescript" : "module";
          return { url: candidate.href, shortCircuit: true, format };
        }
      }
    }
    throw err;
  }
}
