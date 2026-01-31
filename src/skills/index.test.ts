import {describe, it, expect, beforeEach, afterEach} from 'bun:test'
import {mkdirSync, writeFileSync, rmSync} from 'fs'
import {join} from 'path'
import {tmpdir} from 'os'
import {discoverSkills, formatSkillsCatalog, refreshSkills} from './index'

describe('skills', () => {
  let testDir: string
  let homeDir: string

  beforeEach(() => {
    // Create temp directories for testing
    testDir = join(tmpdir(), `nuum-skills-test-${Date.now()}`)
    homeDir = join(tmpdir(), `nuum-skills-home-${Date.now()}`)
    mkdirSync(testDir, {recursive: true})
    mkdirSync(homeDir, {recursive: true})

    // Clear cache before each test
    refreshSkills()
  })

  afterEach(() => {
    // Clean up temp directories
    rmSync(testDir, {recursive: true, force: true})
    rmSync(homeDir, {recursive: true, force: true})
  })

  function createSkill(
    baseDir: string,
    dotDir: string,
    name: string,
    description: string,
  ): void {
    const skillDir = join(baseDir, dotDir, 'skills', name)
    mkdirSync(skillDir, {recursive: true})
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: ${name}
description: ${description}
---

# ${name}

Instructions here...
`,
    )
  }

  describe('discoverSkills', () => {
    it('discovers skills in $CWD/.nuum/skills/', () => {
      createSkill(testDir, '.nuum', 'deploy', 'Deploy to production')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('deploy')
      expect(skills[0].description).toBe('Deploy to production')
      expect(skills[0].path).toContain('.nuum/skills/deploy/SKILL.md')
    })

    it('discovers skills in $CWD/.claude/skills/', () => {
      createSkill(testDir, '.claude', 'testing', 'Run tests')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('testing')
    })

    it('discovers skills in $CWD/.codex/skills/', () => {
      createSkill(testDir, '.codex', 'lint', 'Run linter')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('lint')
    })

    it('respects precedence: .nuum > .claude > .codex', () => {
      createSkill(testDir, '.nuum', 'deploy', 'Nuum deploy')
      createSkill(testDir, '.claude', 'deploy', 'Claude deploy')
      createSkill(testDir, '.codex', 'deploy', 'Codex deploy')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('deploy')
      expect(skills[0].description).toBe('Nuum deploy')
      expect(skills[0].path).toContain('.nuum/skills')
    })

    it('discovers skills one level down (cloned repos)', () => {
      const repoDir = join(testDir, 'my-repo')
      mkdirSync(repoDir, {recursive: true})
      createSkill(repoDir, '.claude', 'repo-skill', 'Skill from repo')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('repo-skill')
      expect(skills[0].path).toContain('my-repo/.claude/skills')
    })

    it('$CWD skills take precedence over subdirectory skills', () => {
      createSkill(testDir, '.nuum', 'deploy', 'CWD deploy')

      const repoDir = join(testDir, 'my-repo')
      mkdirSync(repoDir, {recursive: true})
      createSkill(repoDir, '.nuum', 'deploy', 'Repo deploy')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(1)
      expect(skills[0].description).toBe('CWD deploy')
    })

    it('combines skills from multiple sources', () => {
      createSkill(testDir, '.nuum', 'deploy', 'Deploy skill')
      createSkill(testDir, '.claude', 'testing', 'Testing skill')

      const repoDir = join(testDir, 'my-repo')
      mkdirSync(repoDir, {recursive: true})
      createSkill(repoDir, '.codex', 'lint', 'Lint skill')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(3)
      const names = skills.map((s) => s.name).sort()
      expect(names).toEqual(['deploy', 'lint', 'testing'])
    })

    it('skips skills with invalid names', () => {
      // Create skill with invalid name (uppercase)
      const skillDir = join(testDir, '.nuum', 'skills', 'Invalid-Name')
      mkdirSync(skillDir, {recursive: true})
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: Invalid-Name
description: Should be skipped
---
`,
      )

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(0)
    })

    it('skips skills without frontmatter', () => {
      const skillDir = join(testDir, '.nuum', 'skills', 'no-frontmatter')
      mkdirSync(skillDir, {recursive: true})
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `# No Frontmatter

Just some content without YAML frontmatter.
`,
      )

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(0)
    })

    it('skips skills without required fields', () => {
      const skillDir = join(testDir, '.nuum', 'skills', 'missing-desc')
      mkdirSync(skillDir, {recursive: true})
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: missing-desc
---

No description field.
`,
      )

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(0)
    })

    it('truncates long descriptions', () => {
      const longDesc = 'A'.repeat(300)
      createSkill(testDir, '.nuum', 'verbose', longDesc)

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(1)
      expect(skills[0].description.length).toBe(255)
      expect(skills[0].description.endsWith('...')).toBe(true)
    })

    it('returns empty array when no skills found', () => {
      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(0)
    })

    it('skips hidden subdirectories', () => {
      const hiddenDir = join(testDir, '.hidden-repo')
      mkdirSync(hiddenDir, {recursive: true})
      createSkill(hiddenDir, '.nuum', 'hidden-skill', 'Should not be found')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(0)
    })

    it('discovers skills in $HOME/.nuum/skills/', () => {
      createSkill(homeDir, '.nuum', 'global-skill', 'Global skill from home')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('global-skill')
      expect(skills[0].description).toBe('Global skill from home')
    })

    it('$CWD skills take precedence over $HOME skills', () => {
      createSkill(testDir, '.nuum', 'deploy', 'CWD deploy')
      createSkill(homeDir, '.nuum', 'deploy', 'HOME deploy')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(1)
      expect(skills[0].description).toBe('CWD deploy')
    })

    it('combines $CWD and $HOME skills', () => {
      createSkill(testDir, '.nuum', 'local-skill', 'Local skill')
      createSkill(homeDir, '.claude', 'global-skill', 'Global skill')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(2)
      const names = skills.map((s) => s.name).sort()
      expect(names).toEqual(['global-skill', 'local-skill'])
    })
  })

  describe('formatSkillsCatalog', () => {
    it('returns null for empty skills array', () => {
      const result = formatSkillsCatalog([])

      expect(result).toBeNull()
    })

    it('formats single skill correctly', () => {
      const skills = [
        {
          name: 'deploy',
          description: 'Deploy to production',
          path: '/home/user/project/.nuum/skills/deploy/SKILL.md',
        },
      ]

      const result = formatSkillsCatalog(skills)

      expect(result).toContain('## Skills')
      expect(result).toContain('### Available Skills')
      expect(result).toContain(
        '- deploy: Deploy to production (file: /home/user/project/.nuum/skills/deploy/SKILL.md)',
      )
      expect(result).toContain('### Using Skills')
    })

    it('formats multiple skills correctly', () => {
      const skills = [
        {
          name: 'deploy',
          description: 'Deploy to production',
          path: '/path/deploy/SKILL.md',
        },
        {
          name: 'testing',
          description: 'Run tests',
          path: '/path/testing/SKILL.md',
        },
      ]

      const result = formatSkillsCatalog(skills)

      expect(result).toContain('- deploy: Deploy to production')
      expect(result).toContain('- testing: Run tests')
    })

    it('includes usage instructions', () => {
      const skills = [
        {name: 'deploy', description: 'Deploy', path: '/path/SKILL.md'},
      ]

      const result = formatSkillsCatalog(skills)

      expect(result).toContain('**When to use:**')
      expect(result).toContain('**How to use (progressive disclosure):**')
      expect(result).toContain('**Multiple skills:**')
      expect(result).toContain('**Context hygiene:**')
      expect(result).toContain('**Fallback:**')
    })
  })

  describe('skill name validation', () => {
    it('accepts valid names', () => {
      createSkill(testDir, '.nuum', 'valid-name', 'Valid')
      createSkill(testDir, '.claude', 'another123', 'Also valid')
      createSkill(testDir, '.codex', 'a', 'Single char')

      const skills = discoverSkills({cwd: testDir, home: homeDir})

      expect(skills).toHaveLength(3)
    })

    it('rejects names with uppercase', () => {
      const skillDir = join(testDir, '.nuum', 'skills', 'test')
      mkdirSync(skillDir, {recursive: true})
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: TestSkill
description: Has uppercase
---
`,
      )

      const skills = discoverSkills({cwd: testDir, home: homeDir})
      expect(skills).toHaveLength(0)
    })

    it('rejects names starting with hyphen', () => {
      const skillDir = join(testDir, '.nuum', 'skills', 'test')
      mkdirSync(skillDir, {recursive: true})
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: -invalid
description: Starts with hyphen
---
`,
      )

      const skills = discoverSkills({cwd: testDir, home: homeDir})
      expect(skills).toHaveLength(0)
    })

    it('rejects names ending with hyphen', () => {
      const skillDir = join(testDir, '.nuum', 'skills', 'test')
      mkdirSync(skillDir, {recursive: true})
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: invalid-
description: Ends with hyphen
---
`,
      )

      const skills = discoverSkills({cwd: testDir, home: homeDir})
      expect(skills).toHaveLength(0)
    })

    it('rejects names with consecutive hyphens', () => {
      const skillDir = join(testDir, '.nuum', 'skills', 'test')
      mkdirSync(skillDir, {recursive: true})
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: in--valid
description: Has consecutive hyphens
---
`,
      )

      const skills = discoverSkills({cwd: testDir, home: homeDir})
      expect(skills).toHaveLength(0)
    })

    it('rejects names over 64 characters', () => {
      const longName = 'a'.repeat(65)
      const skillDir = join(testDir, '.nuum', 'skills', 'test')
      mkdirSync(skillDir, {recursive: true})
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: ${longName}
description: Name too long
---
`,
      )

      const skills = discoverSkills({cwd: testDir, home: homeDir})
      expect(skills).toHaveLength(0)
    })
  })
})
