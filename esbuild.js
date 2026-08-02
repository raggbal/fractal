// esbuild bundle script (sprint 20260802-212934-aws-sdk-migration / DOM-BundleBuild)
//
// entry: src/extension.ts -> out/extension.js（バンドル一本化）
//   --bundle --platform=node --external:vscode --format=cjs --minify --sourcemap
//   process.argv に --watch があれば watch モード。
//
// SDK（@aws-sdk/*）はバンドルに畳み込む（external にしない）。vscode のみ external
// （実行時に VS Code が供給）。手書き .js（editor-body-html 等）への variable require は
// esbuild が静的解決できず素通しするため警告が出るが、out/shared に copy 済みで
// 実行時 disk require が正しい挙動（research R-2）。警告はビルドを止めない。
//
// 静的 require（i18n/messages.ts の LOCALE_LOADERS 等）は esbuild がバンドルに畳み込む
// （R-1/R-2 の HIGH = i18n locales の variable require はソースの静的マップ化で解消済み）。

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
  outfile: path.join(__dirname, 'out', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  minify: true,
  sourcemap: true,
  logLevel: 'info',
};

function reportSize() {
  try {
    const stat = fs.statSync(buildOptions.outfile);
    const mb = (stat.size / 1024 / 1024).toFixed(2);
    console.log(`[esbuild] out/extension.js: ${mb} MB (${stat.size} bytes)`);
  } catch (e) {
    console.warn('[esbuild] size report failed:', e && e.message);
  }
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
    // context().watch() は解決後もプロセスを生かし続ける（tsc -watch 相当）。
  } else {
    await esbuild.build(buildOptions);
    reportSize();
  }
}

main().catch((err) => {
  console.error('[esbuild] build failed:', err);
  process.exit(1);
});
