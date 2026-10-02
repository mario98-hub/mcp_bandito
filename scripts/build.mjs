// Build: compile the server with tsc, bundle the UI into one self-contained HTML file.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
execSync('npx tsc -p tsconfig.json', { stdio: 'inherit' });
execSync('npx tsc -p tsconfig.ui.json', { stdio: 'inherit' });

const out = await build({
  entryPoints: ['src/ui/app.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  write: false,
  legalComments: 'none',
  platform: 'browser',
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('src/ui/index.html', 'utf8').replace('/*__APP__*/', () => js);
mkdirSync('dist/ui', { recursive: true });
writeFileSync('dist/ui/index.html', html);
chmodSync('dist/cli.js', 0o755);
console.log(`UI: ${(html.length / 1024).toFixed(0)} KB`);
