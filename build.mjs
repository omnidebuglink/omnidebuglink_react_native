import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function build() {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const version = pkg.version;

  // Version consistency check — same rule as the web client: the tag the
  // release workflow cuts comes from package.json, and libVersion rides every
  // hello frame; a mismatch ships a silently mislabeled SDK.
  const src = readFileSync(new URL('./src/OmniDebugLink.ts', import.meta.url), 'utf8');
  const m = src.match(/LIB_VERSION\s*=\s*'([^']+)'/);
  if (!m || m[1] !== version) {
    console.error(
      `version mismatch: package.json=${version} src/OmniDebugLink.ts LIB_VERSION=${m?.[1] ?? '(not found)'} — fix both before building`,
    );
    process.exit(1);
  }

  await esbuild.build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    bundle: true,
    platform: 'neutral',
    target: 'es2020',
    format: 'cjs',
    banner: { js: `// @omnidebuglink/react-native v${version}` },
    packages: 'external',
  });

  await esbuild.build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.mjs',
    bundle: true,
    platform: 'neutral',
    target: 'es2020',
    format: 'esm',
    banner: { js: `// @omnidebuglink/react-native v${version}` },
    packages: 'external',
  });

  // Generate type declarations
  execSync('npx tsc --emitDeclarationOnly --outDir dist', { cwd: __dirname });
  console.log(`Build complete: @omnidebuglink/react-native v${version}`);
}

build().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});