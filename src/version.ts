/**
 * Version information for miriad-code
 */

import { execSync } from "child_process"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

// Get package.json version
function getPackageVersion(): string {
  try {
    // Try relative to this file first (works in dev)
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(__dirname, "..", "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    return pkg.version || "0.0.0"
  } catch {
    return "0.0.0"
  }
}

// Get git commit hash
function getGitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
  } catch {
    return "unknown"
  }
}

export const VERSION = getPackageVersion()
export const GIT_HASH = getGitHash()
export const VERSION_STRING = `miriad-code v${VERSION} (${GIT_HASH})`
