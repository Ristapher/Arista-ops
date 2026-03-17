
const fs = require('fs');
const ts = require('./node_modules/typescript/lib/typescript.js');
const source = fs.readFileSync('./src/index.ts', 'utf8');
const result = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true,
});
if (result.diagnostics?.length) {
  for (const d of result.diagnostics) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    console.error(msg);
  }
  process.exit(1);
}
console.log('ok');
