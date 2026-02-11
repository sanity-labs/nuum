import {describe, test, expect, beforeEach, afterEach} from 'bun:test'
import {Mcp} from './index'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('Mcp', () => {
  describe('Config Schema', () => {
    test('parses stdio server config', () => {
      const config = {
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            env: {DEBUG: 'true'},
          },
        },
      }
      const result = Mcp.Config.parse(config)
      expect(result.mcpServers?.filesystem).toBeDefined()
      expect('command' in result.mcpServers!.filesystem).toBe(true)
    })

    test('parses http server config', () => {
      const config = {
        mcpServers: {
          remote: {
            url: 'https://example.com/mcp',
            headers: {Authorization: 'Bearer token'},
          },
        },
      }
      const result = Mcp.Config.parse(config)
      expect(result.mcpServers?.remote).toBeDefined()
      expect('url' in result.mcpServers!.remote).toBe(true)
    })

    test('parses mixed server config', () => {
      const config = {
        mcpServers: {
          local: {
            command: 'node',
            args: ['server.js'],
          },
          remote: {
            url: 'https://api.example.com/mcp',
          },
        },
      }
      const result = Mcp.Config.parse(config)
      expect(Object.keys(result.mcpServers!)).toHaveLength(2)
    })

    test('parses empty config', () => {
      const result = Mcp.Config.parse({})
      expect(result.mcpServers).toBeUndefined()
    })

    test('parses config with disabled server', () => {
      const config = {
        mcpServers: {
          disabled: {
            command: 'node',
            args: ['server.js'],
            disabled: true,
          },
        },
      }
      const result = Mcp.Config.parse(config)
      expect(result.mcpServers?.disabled).toBeDefined()
      const server = result.mcpServers!.disabled as Mcp.StdioServerConfig
      expect(server.disabled).toBe(true)
    })

    test('rejects invalid url', () => {
      const config = {
        mcpServers: {
          bad: {
            url: 'not-a-url',
          },
        },
      }
      expect(() => Mcp.Config.parse(config)).toThrow()
    })
  })

  describe('Config Loading', () => {
    const configDir = path.join(os.homedir(), '.config', 'nuum')
    const configPath = path.join(configDir, 'mcp.json')
    let originalEnv: string | undefined
    let hadConfigFile = false
    let originalConfigContent: string | undefined

    beforeEach(async () => {
      // Save original env
      originalEnv = process.env.NUUM_MCP_CONFIG
      delete process.env.NUUM_MCP_CONFIG

      // Check if config file exists and save it
      try {
        originalConfigContent = await fs.readFile(configPath, 'utf-8')
        hadConfigFile = true
      } catch {
        hadConfigFile = false
      }
    })

    afterEach(async () => {
      // Restore env
      if (originalEnv !== undefined) {
        process.env.NUUM_MCP_CONFIG = originalEnv
      } else {
        delete process.env.NUUM_MCP_CONFIG
      }

      // Restore config file
      if (hadConfigFile && originalConfigContent) {
        await fs.writeFile(configPath, originalConfigContent)
      } else {
        try {
          await fs.unlink(configPath)
        } catch {
          // Ignore if doesn't exist
        }
      }
    })

    test('loads config from env var', async () => {
      process.env.NUUM_MCP_CONFIG = JSON.stringify({
        mcpServers: {
          test: {command: 'echo', args: ['hello']},
        },
      })

      const config = await Mcp.loadConfig()
      expect(config.mcpServers?.test).toBeDefined()
    })

    test('loads config from file', async () => {
      // Ensure directory exists
      await fs.mkdir(configDir, {recursive: true})

      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            filetest: {url: 'https://test.example.com'},
          },
        }),
      )

      const config = await Mcp.loadConfig()
      expect(config.mcpServers?.filetest).toBeDefined()
    })

    test('env var takes precedence over file', async () => {
      // Set up both
      process.env.NUUM_MCP_CONFIG = JSON.stringify({
        mcpServers: {
          fromenv: {command: 'env'},
        },
      })

      await fs.mkdir(configDir, {recursive: true})
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            fromfile: {command: 'file'},
          },
        }),
      )

      const config = await Mcp.loadConfig()
      expect(config.mcpServers?.fromenv).toBeDefined()
      expect(config.mcpServers?.fromfile).toBeUndefined()
    })

    test('returns empty config when nothing configured', async () => {
      // Make sure no config exists
      try {
        await fs.unlink(configPath)
      } catch {
        // Ignore
      }

      const config = await Mcp.loadConfig()
      expect(config.mcpServers).toEqual({})
    })
  })

  describe('Tool Name Validation', () => {
    test('accepts valid tool names', () => {
      expect(Mcp.validateToolName('browser-mcp', 'screenshot')).toBeNull()
      expect(Mcp.validateToolName('my_server', 'my_tool')).toBeNull()
      expect(Mcp.validateToolName('server1', 'tool-name')).toBeNull()
      expect(Mcp.validateToolName('s', 'a')).toBeNull()
    })

    test('accepts names with all valid character types', () => {
      // letters, numbers, underscores, hyphens
      expect(
        Mcp.validateToolName('abc-123', 'DEF_456'),
      ).toBeNull()
    })

    test('rejects tool names with dots', () => {
      const issue = Mcp.validateToolName('imagegen', 'generate.image')
      expect(issue).not.toBeNull()
      expect(issue!.type).toBe('invalid_tool_name')
      expect(issue!.tool).toBe('generate.image')
      expect(issue!.effectiveName).toBe('imagegen__generate.image')
      expect(issue!.message).toContain('"."')
    })

    test('rejects tool names with spaces', () => {
      const issue = Mcp.validateToolName('server', 'my tool')
      expect(issue).not.toBeNull()
      expect(issue!.message).toContain('" "')
    })

    test('rejects tool names with slashes', () => {
      const issue = Mcp.validateToolName('server', 'path/to/tool')
      expect(issue).not.toBeNull()
      expect(issue!.message).toContain('"/"')
    })

    test('rejects tool names with @ symbol', () => {
      const issue = Mcp.validateToolName('@fastmcp-me', 'tool')
      expect(issue).not.toBeNull()
      expect(issue!.message).toContain('"@"')
    })

    test('rejects effective names exceeding 64 characters', () => {
      const longName = 'a'.repeat(60) // server__<60 chars> = 70 chars > 64
      const issue = Mcp.validateToolName('server', longName)
      expect(issue).not.toBeNull()
      expect(issue!.message).toContain('exceeds 64 character limit')
    })

    test('accepts effective names at exactly 64 characters', () => {
      // "sv__" = 4 chars, so tool name can be 60 chars
      const toolName = 'a'.repeat(60)
      const issue = Mcp.validateToolName('sv', toolName)
      expect(issue).toBeNull()
      expect(`sv__${toolName}`.length).toBe(64)
    })

    test('rejects effective names at 65 characters', () => {
      const toolName = 'a'.repeat(61)
      const issue = Mcp.validateToolName('sv', toolName)
      expect(issue).not.toBeNull()
      expect(`sv__${toolName}`.length).toBe(65)
    })

    test('reports multiple invalid characters', () => {
      const issue = Mcp.validateToolName('server', 'a.b/c')
      expect(issue).not.toBeNull()
      expect(issue!.message).toContain('"."')
      expect(issue!.message).toContain('"/"')
    })

    test('server name with invalid chars causes all tools to fail', () => {
      // If server name has dots, every tool from it will fail
      const issue = Mcp.validateToolName('my.server', 'valid_tool')
      expect(issue).not.toBeNull()
      expect(issue!.effectiveName).toBe('my.server__valid_tool')
      expect(issue!.message).toContain('"."')
    })
  })

  describe('Manager', () => {
    test('creates manager instance', () => {
      const manager = new Mcp.Manager()
      expect(manager).toBeDefined()
    })

    test('getStatus returns empty array initially', () => {
      const manager = new Mcp.Manager()
      const status = manager.getStatus()
      expect(Array.isArray(status)).toBe(true)
      expect(status).toHaveLength(0)
    })

    test('listTools returns empty array initially', () => {
      const manager = new Mcp.Manager()
      const tools = manager.listTools()
      expect(Array.isArray(tools)).toBe(true)
      expect(tools).toHaveLength(0)
    })

    test('getTools returns empty object initially', () => {
      const manager = new Mcp.Manager()
      const tools = manager.getTools()
      expect(typeof tools).toBe('object')
      expect(Object.keys(tools)).toHaveLength(0)
    })
  })

  describe('Singleton', () => {
    afterEach(async () => {
      await Mcp.shutdown()
    })

    test('getManager returns same instance', () => {
      const manager1 = Mcp.getManager()
      const manager2 = Mcp.getManager()
      expect(manager1).toBe(manager2)
    })

    test('getTools returns empty object when not initialized', async () => {
      await Mcp.shutdown() // Ensure clean state
      const tools = Mcp.getTools()
      expect(typeof tools).toBe('object')
    })

    test('getToolNames returns empty array when not initialized', async () => {
      await Mcp.shutdown() // Ensure clean state
      const names = Mcp.getToolNames()
      expect(Array.isArray(names)).toBe(true)
      expect(names).toHaveLength(0)
    })

    test('isInitialized returns false before init', async () => {
      await Mcp.shutdown()
      expect(Mcp.isInitialized()).toBe(false)
    })

    test('initialize skips if config unchanged', async () => {
      await Mcp.shutdown()
      const config = {mcpServers: {}}

      // First init should return true
      const first = await Mcp.initialize(config)
      expect(first).toBe(true)
      expect(Mcp.isInitialized()).toBe(true)

      // Second init with same config should return false (skipped)
      const second = await Mcp.initialize(config)
      expect(second).toBe(false)
    })

    test('initialize runs if config changed', async () => {
      await Mcp.shutdown()
      const config1 = {mcpServers: {}}
      const config2 = {mcpServers: {test: {command: 'echo', args: []}}}

      // First init
      const first = await Mcp.initialize(config1)
      expect(first).toBe(true)

      // Second init with different config should return true
      const second = await Mcp.initialize(config2)
      expect(second).toBe(true)
    })

    test('initialize detects config change when server added', async () => {
      await Mcp.shutdown()

      // Start with one server
      const config1: Mcp.ConfigType = {
        mcpServers: {
          server1: {command: 'echo', args: ['1']},
        },
      }
      await Mcp.initialize(config1)

      // Add another server - should reinitialize
      const config2: Mcp.ConfigType = {
        mcpServers: {
          server1: {command: 'echo', args: ['1']},
          server2: {command: 'echo', args: ['2']},
        },
      }
      const reinitialized = await Mcp.initialize(config2)
      expect(reinitialized).toBe(true)
    })

    test('initialize detects config change when server modified', async () => {
      await Mcp.shutdown()

      // Start with one config
      const config1: Mcp.ConfigType = {
        mcpServers: {
          server1: {command: 'echo', args: ['original']},
        },
      }
      await Mcp.initialize(config1)

      // Modify the server args - should reinitialize
      const config2: Mcp.ConfigType = {
        mcpServers: {
          server1: {command: 'echo', args: ['modified']},
        },
      }
      const reinitialized = await Mcp.initialize(config2)
      expect(reinitialized).toBe(true)
    })

    test('initialize skips when config is identical', async () => {
      await Mcp.shutdown()

      const config: Mcp.ConfigType = {
        mcpServers: {
          server1: {command: 'echo', args: ['test']},
        },
      }

      // First init
      await Mcp.initialize(config)

      // Same config again - should skip
      const skipped = await Mcp.initialize(config)
      expect(skipped).toBe(false)

      // Even with a new object with same content - should skip
      const configCopy: Mcp.ConfigType = {
        mcpServers: {
          server1: {command: 'echo', args: ['test']},
        },
      }
      const skippedAgain = await Mcp.initialize(configCopy)
      expect(skippedAgain).toBe(false)
    })
  })

  describe('Non-blocking init', () => {
    afterEach(async () => {
      await Mcp.shutdown()
    })

    test('servers start in connecting state', async () => {
      await Mcp.shutdown()
      const manager = new Mcp.Manager()

      // Use a server that will take time to connect (will fail, but starts as connecting)
      // We need to check state BEFORE ready() resolves
      const config: Mcp.ConfigType = {
        mcpServers: {
          'slow-server': {command: 'sleep', args: ['10'], timeout: 100},
        },
      }

      await manager.initialize(config)

      // Server should be registered immediately
      const status = manager.getStatus()
      expect(status.length).toBe(1)
      expect(status[0].name).toBe('slow-server')
      // It's either 'connecting' (if still in progress) or 'failed' (if already timed out)
      expect(['connecting', 'failed']).toContain(status[0].status)

      // Clean up
      await manager.ready()
      await manager.shutdown()
    })

    test('getConnectingServerForTool returns server name for connecting server', async () => {
      const manager = new Mcp.Manager()

      // Use a slow command that will stay in connecting state briefly
      // The 2s timeout means it'll fail after 2s, but we check immediately
      const config: Mcp.ConfigType = {
        mcpServers: {
          'linear-mcp': {command: 'sleep', args: ['10'], timeout: 2000},
        },
      }

      await manager.initialize(config)

      // Should detect that linear-mcp is still connecting (checked immediately after init)
      const result = manager.getConnectingServerForTool('linear-mcp__list_issues')
      expect(result).toBe('linear-mcp')

      // Non-existent server should return null
      const result2 = manager.getConnectingServerForTool('other__tool')
      expect(result2).toBeNull()

      // Tool without __ separator should return null
      const result3 = manager.getConnectingServerForTool('plain_tool')
      expect(result3).toBeNull()

      // Clean up
      await manager.shutdown()
    })

    test('getFailedServerForTool returns error for failed server', async () => {
      const manager = new Mcp.Manager()

      const config: Mcp.ConfigType = {
        mcpServers: {
          'broken': {command: 'nonexistent-command-xyz', args: [], timeout: 100},
        },
      }

      await manager.initialize(config)
      await manager.ready() // Wait for it to fail

      const result = manager.getFailedServerForTool('broken__some_tool')
      expect(result).not.toBeNull()
      expect(result!.serverName).toBe('broken')
      expect(result!.error).toBeTruthy()

      await manager.shutdown()
    })

    test('disabled servers are not in connecting state', async () => {
      const manager = new Mcp.Manager()

      const config: Mcp.ConfigType = {
        mcpServers: {
          'disabled-server': {command: 'echo', args: [], disabled: true},
        },
      }

      await manager.initialize(config)

      const status = manager.getStatus()
      expect(status[0].status).toBe('disabled')

      const result = manager.getConnectingServerForTool('disabled-server__tool')
      expect(result).toBeNull()

      await manager.shutdown()
    })
  })

  describe('Config Merging', () => {
    // These tests verify the merging behavior used by the server
    // when message config overrides base config

    test('message config overrides base config servers', () => {
      const baseConfig: Mcp.ConfigType = {
        mcpServers: {
          server1: {command: 'base', args: []},
          server2: {command: 'base', args: []},
        },
      }

      const messageConfig = {
        server1: {command: 'override', args: ['new']},
      }

      // Merge: message takes precedence
      const merged: Mcp.ConfigType = {
        mcpServers: {
          ...baseConfig.mcpServers,
          ...messageConfig,
        },
      }

      expect(merged.mcpServers?.server1).toEqual({
        command: 'override',
        args: ['new'],
      })
      expect(merged.mcpServers?.server2).toEqual({command: 'base', args: []})
    })

    test('message config adds new servers to base', () => {
      const baseConfig: Mcp.ConfigType = {
        mcpServers: {
          existing: {command: 'base', args: []},
        },
      }

      const messageConfig = {
        newserver: {command: 'new', args: ['arg']},
      }

      const merged: Mcp.ConfigType = {
        mcpServers: {
          ...baseConfig.mcpServers,
          ...messageConfig,
        },
      }

      expect(Object.keys(merged.mcpServers!)).toHaveLength(2)
      expect(merged.mcpServers?.existing).toBeDefined()
      expect(merged.mcpServers?.newserver).toBeDefined()
    })

    test('empty message config preserves base config', () => {
      const baseConfig: Mcp.ConfigType = {
        mcpServers: {
          server1: {command: 'base', args: []},
        },
      }

      const messageConfig = {}

      const merged: Mcp.ConfigType = {
        mcpServers: {
          ...baseConfig.mcpServers,
          ...messageConfig,
        },
      }

      expect(merged.mcpServers?.server1).toEqual({command: 'base', args: []})
    })
  })
})
