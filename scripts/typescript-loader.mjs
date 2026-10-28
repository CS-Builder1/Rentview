import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    if (!path.extname(base)) for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      if (existsSync(base + suffix)) return { url: pathToFileURL(base + suffix).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && /\.tsx?$/.test(url)) {
    const filename = fileURLToPath(url);
    if (filename.startsWith(root + path.sep) && !filename.includes(`${path.sep}node_modules${path.sep}`)) {
      const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: false },
      }).outputText;
      return { source, format: 'module', shortCircuit: true };
    }
  }
  return nextLoad(url, context);
}
