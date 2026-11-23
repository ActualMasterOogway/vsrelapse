import * as esbuild from 'esbuild';
import { readdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');
if (test) await rm('.test-build', { recursive: true, force: true });

const ctx = await esbuild.context({
  entryPoints: test
    ? (await readdir('test'))
      .filter(name => name.endsWith('.test.ts'))
      .map(name => `test/${name}`)
      .concat('test/e2e/suite.ts')
    : ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: !watch && !test,
  sourcemap: watch || test,
  sourcesContent: false,
  platform: 'node',
  target: 'node20',
  ...(test ? { outdir: '.test-build', outbase: '.' } : { outfile: 'dist/extension.js' }),
  external: ['vscode'],
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
