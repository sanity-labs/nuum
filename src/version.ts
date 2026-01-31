/**
 * Version information for nuum
 *
 * BUILD_VERSION and BUILD_GIT_HASH are injected at build time via Bun's --define flag.
 * They fall back to runtime detection for development.
 */

import {execSync} from 'child_process'
import {readFileSync} from 'fs'
import {join, dirname} from 'path'
import {fileURLToPath} from 'url'

// Declare build-time constants (injected by Bun's --define)
declare const BUILD_VERSION: string | undefined
declare const BUILD_GIT_HASH: string | undefined

// Get package.json version (fallback for dev)
function getPackageVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// Get git commit hash (fallback for dev)
function getGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

// Use build-time values if available, otherwise fall back to runtime detection
export const VERSION =
  typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : getPackageVersion()
export const GIT_HASH =
  typeof BUILD_GIT_HASH !== 'undefined' ? BUILD_GIT_HASH : getGitHash()
export const VERSION_STRING = `nuum v${VERSION} (${GIT_HASH})`
