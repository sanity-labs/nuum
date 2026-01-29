/**
 * Skills discovery and management.
 *
 * Skills are reference documentation that the agent can read to perform
 * specific tasks. The agent sees a catalog of available skills in its
 * system prompt and reads the full content directly from disk when needed.
 *
 * Discovery locations (in precedence order):
 * 1. $CWD/.nuum/skills/, .claude/skills/, .codex/skills/
 * 2. $CWD/<subdir>/.nuum/skills/, etc. (one level down)
 * 3. $HOME/.nuum/skills/, etc. (global skills)
 *
 * Skills are re-scanned after every turn to pick up newly installed skills.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs"
import { join, resolve, dirname } from "path"
import { homedir } from "os"

const MAX_DESCRIPTION_LENGTH = 255

export interface Skill {
  name: string
  description: string
  path: string
}

interface SkillFrontmatter {
  name?: string
  description?: string
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Returns null if frontmatter is missing or invalid.
 */
function parseFrontmatter(content: string): SkillFrontmatter | null {
  // Check for frontmatter delimiters
  if (!content.startsWith("---")) {
    return null
  }

  const endIndex = content.indexOf("\n---", 3)
  if (endIndex === -1) {
    return null
  }

  const frontmatter = content.slice(4, endIndex).trim()
  const result: SkillFrontmatter = {}

  // Simple YAML parsing for name and description
  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":")
    if (colonIndex === -1) continue

    const key = line.slice(0, colonIndex).trim()
    let value = line.slice(colonIndex + 1).trim()

    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    if (key === "name") {
      result.name = value
    } else if (key === "description") {
      result.description = value
    }
  }

  return result
}

/**
 * Validate a skill name according to the spec.
 * - 1-64 chars
 * - lowercase alphanumeric + hyphens
 * - no leading/trailing/consecutive hyphens
 */
function isValidSkillName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false
  if (!/^[a-z0-9-]+$/.test(name)) return false
  if (name.startsWith("-") || name.endsWith("-")) return false
  if (name.includes("--")) return false
  return true
}

/**
 * Truncate description to max length.
 */
function truncateDescription(description: string): string {
  if (description.length <= MAX_DESCRIPTION_LENGTH) {
    return description
  }
  return description.slice(0, MAX_DESCRIPTION_LENGTH - 3) + "..."
}

/**
 * Scan a directory for skills.
 * Returns skills found in .nuum/skills/, .claude/skills/, .codex/skills/
 */
function scanDirectory(dir: string, skills: Map<string, Skill>): void {
  const skillDirs = [".nuum/skills", ".claude/skills", ".codex/skills"]

  for (const skillDir of skillDirs) {
    const skillsPath = join(dir, skillDir)
    if (!existsSync(skillsPath)) continue

    try {
      const entries = readdirSync(skillsPath)
      for (const entry of entries) {
        const entryPath = join(skillsPath, entry)
        const stat = statSync(entryPath)
        if (!stat.isDirectory()) continue

        const skillFile = join(entryPath, "SKILL.md")
        if (!existsSync(skillFile)) continue

        try {
          const content = readFileSync(skillFile, "utf-8")
          const frontmatter = parseFrontmatter(content)
          if (!frontmatter?.name || !frontmatter?.description) continue
          if (!isValidSkillName(frontmatter.name)) continue

          // First one wins (precedence order)
          if (!skills.has(frontmatter.name)) {
            skills.set(frontmatter.name, {
              name: frontmatter.name,
              description: truncateDescription(frontmatter.description),
              path: resolve(skillFile),
            })
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }
}

/**
 * Scan one level down from a directory for skills.
 * This catches skills in cloned repos.
 */
function scanSubdirectories(dir: string, skills: Map<string, Skill>): void {
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      // Skip hidden directories
      if (entry.startsWith(".")) continue

      const entryPath = join(dir, entry)
      try {
        const stat = statSync(entryPath)
        if (stat.isDirectory()) {
          scanDirectory(entryPath, skills)
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch {
    // Skip unreadable directories
  }
}

/**
 * Discover all available skills.
 *
 * Scans in precedence order:
 * 1. $CWD/.nuum/skills/, .claude/skills/, .codex/skills/
 * 2. $CWD/<subdir>/.nuum/skills/, etc. (one level down)
 * 3. $HOME/.nuum/skills/, etc. (global skills)
 */
export function discoverSkills(cwd: string = process.cwd()): Skill[] {
  const skills = new Map<string, Skill>()
  const home = homedir()

  // 1. Scan $CWD
  scanDirectory(cwd, skills)

  // 2. Scan one level down from $CWD
  scanSubdirectories(cwd, skills)

  // 3. Scan $HOME (global skills)
  if (cwd !== home) {
    scanDirectory(home, skills)
  }

  return Array.from(skills.values())
}

/**
 * Format skills catalog for injection into system prompt.
 * Returns null if no skills are available.
 */
export function formatSkillsCatalog(skills: Skill[]): string | null {
  if (skills.length === 0) {
    return null
  }

  const lines = [
    "## Skills",
    "",
    "Skills are local instructions stored in `SKILL.md` files. Each entry below shows a name, description, and file path.",
    "",
    "### Available Skills",
  ]

  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description} (file: ${skill.path})`)
  }

  lines.push("")
  lines.push("### Using Skills")
  lines.push("")
  lines.push("**When to use:** If a task matches a skill's description, use that skill. The user may also request a specific skill by name.")
  lines.push("")
  lines.push("**How to use (progressive disclosure):**")
  lines.push("1. Read the skill's `SKILL.md` file - only what you need for the current task")
  lines.push("2. If it references `scripts/`, `references/`, or `assets/`, load only the specific files needed")
  lines.push("3. Prefer running existing scripts over rewriting code")
  lines.push("")
  lines.push("**Multiple skills:** Choose the minimal set that covers the request. State which skills you're using and why.")
  lines.push("")
  lines.push("**Context hygiene:** Summarize long sections instead of pasting them. Don't bulk-load reference files.")
  lines.push("")
  lines.push("**Fallback:** If a skill can't be applied (missing files, unclear instructions), state the issue and continue with your best approach.")

  return lines.join("\n")
}

// Cache for skills to avoid re-scanning on every call
let cachedSkills: Skill[] | null = null
let cachedCwd: string | null = null

/**
 * Get skills, using cache if CWD hasn't changed.
 * Call refreshSkills() to force a re-scan.
 */
export function getSkills(cwd: string = process.cwd()): Skill[] {
  if (cachedSkills === null || cachedCwd !== cwd) {
    cachedSkills = discoverSkills(cwd)
    cachedCwd = cwd
  }
  return cachedSkills
}

/**
 * Force a re-scan of skills.
 * Call this after every turn to pick up newly installed skills.
 */
export function refreshSkills(): void {
  cachedSkills = null
  cachedCwd = null
}
