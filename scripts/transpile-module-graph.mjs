import fs from "node:fs";
import path from "node:path";
import ts from "../node_modules/typescript/lib/typescript.js";

export function compileTypeScriptModuleGraph(entryPath, outputDir, sourceRoot = path.resolve("src")) {
  const root = sourceRoot;
  const compiled = new Map();

  const compile = (sourcePath) => {
    const absolute = path.resolve(sourcePath);
    if (compiled.has(absolute)) return compiled.get(absolute);
    const relative = path.relative(root, absolute).replace(/\.ts$/, ".mjs");
    const outputPath = path.join(outputDir, relative);
    compiled.set(absolute, outputPath);
    let source = fs.readFileSync(absolute, "utf8");
    source = source.replace(/(from\s+|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g, (match, prefix, quote, specifier) => {
      const dependency = resolveLocalModule(path.resolve(path.dirname(absolute), specifier));
      if (!dependency) return match;
      compile(dependency);
      const dependencyOutput = compiled.get(dependency);
      let next = path.relative(path.dirname(outputPath), dependencyOutput).replace(/\\/g, "/");
      if (!next.startsWith(".")) next = `./${next}`;
      return `${prefix}${quote}${next}${quote}`;
    });
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        verbatimModuleSyntax: false,
      },
    }).outputText;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, transpiled, "utf8");
    return outputPath;
  };

  return compile(entryPath);
}

function resolveLocalModule(base) {
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
  }
  return null;
}
