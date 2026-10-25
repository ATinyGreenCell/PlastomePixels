// Builds both deliverables from src/:
//   site/                       the GitHub Pages app: index.html, app.js, engine.js (Web Worker), sw.js,
//                               version.json, manifest, icons, fonts
//   dist/plastome-pixels.html   one self-contained page that works from a file, offline (a release download)
//   dist/artifact-body.html     the same page without its document shell, as claude.ai artifacts take it
// Usage: node build.mjs [--dev]   (--dev keeps the scripts readable)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const dev = process.argv.includes('--dev');
const version = /APP_VERSION = "([^"]+)"/.exec(readFileSync('src/version.ts', 'utf8'))[1];
const common = { bundle: true, write: false, legalComments: 'none', charset: 'utf8', target: ['es2020', 'safari14'], minify: !dev, logLevel: 'warning' };

// 1. sample metadata (composition and inverted repeats), only when the samples changed
const metaTs = 'src/sampleMeta.ts';
if (!existsSync(metaTs) || statSync(metaTs).mtimeMs < statSync('src/samples.ts').mtimeMs) {
  await build({ ...common, minify: false, write: true, entryPoints: ['scripts/sample-meta.ts'], platform: 'node', format: 'esm', outfile: '.build/sample-meta.mjs' });
  execFileSync(process.execPath, ['.build/sample-meta.mjs', metaTs], { stdio: 'inherit' });
}

const bundle = async (entry, define = {}, format = 'iife') =>
  (await build({ ...common, entryPoints: [entry], format, define })).outputFiles[0].text;

const engine = await bundle('src/engine-entry.ts');
const appPages = await bundle('src/main.ts', { __TARGET__: '"pages"', __ENGINE_URL__: '"./engine.js"' });
const appArtifact = await bundle('src/main.ts', { __TARGET__: '"artifact"', __ENGINE_URL__: '""' });
const sw = await bundle('src/sw.ts', { __VERSION__: JSON.stringify(version) });

const tpl = readFileSync('src/template.html', 'utf8');
const [head, body] = tpl.split('<!--BODY-->');
const noScriptClose = s => s.replace(/<\/script/gi, '<\\/script');

// 2. GitHub Pages site
rmSync('site', { recursive: true, force: true });
mkdirSync('site', { recursive: true });
cpSync('static', 'site', { recursive: true });
const csp = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self' https://eutils.ncbi.nlm.nih.gov", "worker-src 'self' blob:",
  "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
const pagesHead = head.replace('<!--HEAD-EXTRA-->', [
  `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
  '<meta name="theme-color" content="#131814">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="Plastome">',
  '<link rel="apple-touch-icon" href="icon-180.png">',
  '<link rel="icon" href="icon-192.png">',
  '<link rel="manifest" href="manifest.webmanifest">',
  // no <link rel=preload> for engine.js: a worker's fetch can't use a script preload, so it would download twice
].join('\n'));
writeFileSync('site/index.html', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${pagesHead.trim()}
<script src="app.js" defer></script>
</head>
<body>
${body.replace('<!--SCRIPTS-->', '<noscript><p style="padding:16px">Plastome Pixels needs JavaScript.</p></noscript>').trim()}
</body>
</html>
`);
writeFileSync('site/app.js', appPages);
writeFileSync('site/engine.js', engine);
writeFileSync('site/sw.js', sw);
writeFileSync('site/version.json', JSON.stringify({ version }) + '\n');

// 3. the single-file page: engine source rides along as text and starts as a blob worker. claude.ai wraps
// an artifact in its own document (charset and viewport included); the download is a whole document.
mkdirSync('dist', { recursive: true });
const artifactHead = head.replace('<!--HEAD-EXTRA-->', [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
].join('\n'));
const singleBody = body.replace('<!--SCRIPTS-->',
  `<script type="text/plain" id="engine-src">${noScriptClose(engine)}</script>\n<script>${noScriptClose(appArtifact)}</script>`);
const single = artifactHead + singleBody;
writeFileSync('dist/artifact-body.html', single);
writeFileSync('dist/plastome-pixels.html', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${artifactHead.trim()}
</head>
<body>
${singleBody.trim()}
</body>
</html>
`);

const kb = s => (Buffer.byteLength(s) / 1024).toFixed(0) + ' KB';
console.log(`v${version}: app ${kb(appPages)}, engine ${kb(engine)}, sw ${kb(sw)}; single file ${kb(single)}`);
