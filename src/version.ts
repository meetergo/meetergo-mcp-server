/**
 * The version, read from the one file that already has to carry it.
 *
 * It surfaces in three places that must agree — the MCP handshake, the
 * User-Agent the api sees, and /healthz — and a hardcoded copy has drifted
 * before (the bundle shipped 0.1.1 while the handshake announced 0.1.0, which
 * makes every bug report wrong). There is nothing to keep in sync if there is
 * only one number.
 *
 * Read at runtime rather than injected at build time because `package.json`
 * sits one directory above the entry in every layout this ships in: the npm
 * package (`dist/` + manifest), the .mcpb bundle (pack.sh copies both), and the
 * Docker image (`/app/dist` beside `/app/package.json`). `createRequire` rather
 * than a JSON import: an import would need `resolveJsonModule` and would make
 * tsc emit a copy of the manifest into `dist/`, which is a second file to drift
 * from — exactly what this module exists to prevent.
 */
import { createRequire } from 'node:module'

const manifest = createRequire(import.meta.url)('../package.json') as {
  version?: unknown
}

if (typeof manifest.version !== 'string' || !manifest.version) {
  // Fail at import: a manifest without a version means the packaging is broken,
  // and the alternative is every consumer of VERSION reporting a placeholder.
  throw new Error(
    'meetergo MCP: package.json carries no version — the package is packed wrong',
  )
}

export const VERSION: string = manifest.version
