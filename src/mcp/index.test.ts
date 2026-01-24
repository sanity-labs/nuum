import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Mcp } from "./index"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

describe("Mcp", () => {
  describe("Config Schema", () => {
    test("parses stdio server config", () => {
      const config = {
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { DEBUG: "true" },
          },
        },
      }
      const result = Mcp.Config.parse(config)
      expect(result.mcpServers?.filesystem).toBeDefined()
      expect("command" in result.mcpServers!.filesystem).toBe(true)
    })

    test("parses http server config", () => {
      const config = {
        mcpServers: {
          remote: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer token" },
          },
        },
      }
      const result = Mcp.Config.parse(config)
      expect(result.mcpServers?.remote).toBeDefined()
      expect("url" in result.mcpServers!.remote).toBe(true)
    })

    test("parses mixed server config", () => {
      const config = {
        mcpServers: {
          local: {
            command: "node",
            args: ["server.js"],
          },
          remote: {
            url: "https://api.example.com/mcp",
          },
        },
      }
      const result = Mcp.Config.parse(config)
      expect(Object.keys(result.mcpServers!)).toHaveLength(2)
    })

    test("parses empty config", () => {
      const result = Mcp.Config.parse({})
      expect(result.mcpServers).toBeUndefined()
    })

    test("parses config with disabled server", () => {
      const config = {
        mcpServers: {
          disabled: {
            command: "node",
            args: ["server.js"],
            disabled: true,
          },
        },
      }
      const result = Mcp.Config.parse(config)
      expect(result.mcpServers?.disabled).toBeDefined()
      const server = result.mcpServers!.disabled as Mcp.StdioServerConfig
      expect(server.disabled).toBe(true)
    })

    test("rejects invalid url", () => {
      const config = {
        mcpServers: {
          bad: {
            url: "not-a-url",
          },
        },
      }
      expect(() => Mcp.Config.parse(config)).toThrow()
    })
  })

  describe("Config Loading", () => {
    const configDir = path.join(os.homedir(), ".config", "miriad")
    const configPath = path.join(configDir, "code.json")
    let originalEnv: string | undefined
    let hadConfigFile = false
    let originalConfigContent: string | undefined

    beforeEach(async () => {
      // Save original env
      originalEnv = process.env.MIRIAD_MCP_CONFIG
      delete process.env.MIRIAD_MCP_CONFIG

      // Check if config file exists and save it
      try {
        originalConfigContent = await fs.readFile(configPath, "utf-8")
        hadConfigFile = true
      } catch {
        hadConfigFile = false
      }
    })

    afterEach(async () => {
      // Restore env
      if (originalEnv !== undefined) {
        process.env.MIRIAD_MCP_CONFIG = originalEnv
      } else {
        delete process.env.MIRIAD_MCP_CONFIG
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

    test("loads config from env var", async () => {
      process.env.MIRIAD_MCP_CONFIG = JSON.stringify({
        mcpServers: {
          test: { command: "echo", args: ["hello"] },
        },
      })

      const config = await Mcp.loadConfig()
      expect(config.mcpServers?.test).toBeDefined()
    })

    test("loads config from file", async () => {
      // Ensure directory exists
      await fs.mkdir(configDir, { recursive: true })
      
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            filetest: { url: "https://test.example.com" },
          },
        })
      )

      const config = await Mcp.loadConfig()
      expect(config.mcpServers?.filetest).toBeDefined()
    })

    test("env var takes precedence over file", async () => {
      // Set up both
      process.env.MIRIAD_MCP_CONFIG = JSON.stringify({
        mcpServers: {
          fromenv: { command: "env" },
        },
      })

      await fs.mkdir(configDir, { recursive: true })
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            fromfile: { command: "file" },
          },
        })
      )

      const config = await Mcp.loadConfig()
      expect(config.mcpServers?.fromenv).toBeDefined()
      expect(config.mcpServers?.fromfile).toBeUndefined()
    })

    test("returns empty config when nothing configured", async () => {
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

  describe("Manager", () => {
    test("creates manager instance", () => {
      const manager = new Mcp.Manager()
      expect(manager).toBeDefined()
    })

    test("getStatus returns empty array initially", () => {
      const manager = new Mcp.Manager()
      const status = manager.getStatus()
      expect(Array.isArray(status)).toBe(true)
      expect(status).toHaveLength(0)
    })

    test("listTools returns empty array initially", () => {
      const manager = new Mcp.Manager()
      const tools = manager.listTools()
      expect(Array.isArray(tools)).toBe(true)
      expect(tools).toHaveLength(0)
    })

    test("getTools returns empty object initially", () => {
      const manager = new Mcp.Manager()
      const tools = manager.getTools()
      expect(typeof tools).toBe("object")
      expect(Object.keys(tools)).toHaveLength(0)
    })
  })

  describe("Singleton", () => {
    afterEach(async () => {
      await Mcp.shutdown()
    })

    test("getManager returns same instance", () => {
      const manager1 = Mcp.getManager()
      const manager2 = Mcp.getManager()
      expect(manager1).toBe(manager2)
    })

    test("getTools returns empty object when not initialized", async () => {
      await Mcp.shutdown() // Ensure clean state
      const tools = Mcp.getTools()
      expect(typeof tools).toBe("object")
    })

    test("getToolNames returns empty array when not initialized", async () => {
      await Mcp.shutdown() // Ensure clean state
      const names = Mcp.getToolNames()
      expect(Array.isArray(names)).toBe(true)
      expect(names).toHaveLength(0)
    })

    test("isInitialized returns false before init", async () => {
      await Mcp.shutdown()
      expect(Mcp.isInitialized()).toBe(false)
    })

    test("initialize skips if config unchanged", async () => {
      await Mcp.shutdown()
      const config = { mcpServers: {} }
      
      // First init should return true
      const first = await Mcp.initialize(config)
      expect(first).toBe(true)
      expect(Mcp.isInitialized()).toBe(true)
      
      // Second init with same config should return false (skipped)
      const second = await Mcp.initialize(config)
      expect(second).toBe(false)
    })

    test("initialize runs if config changed", async () => {
      await Mcp.shutdown()
      const config1 = { mcpServers: {} }
      const config2 = { mcpServers: { test: { command: "echo", args: [] } } }
      
      // First init
      const first = await Mcp.initialize(config1)
      expect(first).toBe(true)
      
      // Second init with different config should return true
      const second = await Mcp.initialize(config2)
      expect(second).toBe(true)
    })

    test("initialize detects config change when server added", async () => {
      await Mcp.shutdown()
      
      // Start with one server
      const config1: Mcp.ConfigType = { 
        mcpServers: { 
          server1: { command: "echo", args: ["1"] } 
        } 
      }
      await Mcp.initialize(config1)
      
      // Add another server - should reinitialize
      const config2: Mcp.ConfigType = { 
        mcpServers: { 
          server1: { command: "echo", args: ["1"] },
          server2: { command: "echo", args: ["2"] }
        } 
      }
      const reinitialized = await Mcp.initialize(config2)
      expect(reinitialized).toBe(true)
    })

    test("initialize detects config change when server modified", async () => {
      await Mcp.shutdown()
      
      // Start with one config
      const config1: Mcp.ConfigType = { 
        mcpServers: { 
          server1: { command: "echo", args: ["original"] } 
        } 
      }
      await Mcp.initialize(config1)
      
      // Modify the server args - should reinitialize
      const config2: Mcp.ConfigType = { 
        mcpServers: { 
          server1: { command: "echo", args: ["modified"] } 
        } 
      }
      const reinitialized = await Mcp.initialize(config2)
      expect(reinitialized).toBe(true)
    })

    test("initialize skips when config is identical", async () => {
      await Mcp.shutdown()
      
      const config: Mcp.ConfigType = { 
        mcpServers: { 
          server1: { command: "echo", args: ["test"] } 
        } 
      }
      
      // First init
      await Mcp.initialize(config)
      
      // Same config again - should skip
      const skipped = await Mcp.initialize(config)
      expect(skipped).toBe(false)
      
      // Even with a new object with same content - should skip
      const configCopy: Mcp.ConfigType = { 
        mcpServers: { 
          server1: { command: "echo", args: ["test"] } 
        } 
      }
      const skippedAgain = await Mcp.initialize(configCopy)
      expect(skippedAgain).toBe(false)
    })
  })

  describe("Config Merging", () => {
    // These tests verify the merging behavior used by the server
    // when message config overrides base config
    
    test("message config overrides base config servers", () => {
      const baseConfig: Mcp.ConfigType = {
        mcpServers: {
          server1: { command: "base", args: [] },
          server2: { command: "base", args: [] },
        }
      }
      
      const messageConfig = {
        server1: { command: "override", args: ["new"] },
      }
      
      // Merge: message takes precedence
      const merged: Mcp.ConfigType = {
        mcpServers: {
          ...baseConfig.mcpServers,
          ...messageConfig,
        }
      }
      
      expect(merged.mcpServers?.server1).toEqual({ command: "override", args: ["new"] })
      expect(merged.mcpServers?.server2).toEqual({ command: "base", args: [] })
    })

    test("message config adds new servers to base", () => {
      const baseConfig: Mcp.ConfigType = {
        mcpServers: {
          existing: { command: "base", args: [] },
        }
      }
      
      const messageConfig = {
        newserver: { command: "new", args: ["arg"] },
      }
      
      const merged: Mcp.ConfigType = {
        mcpServers: {
          ...baseConfig.mcpServers,
          ...messageConfig,
        }
      }
      
      expect(Object.keys(merged.mcpServers!)).toHaveLength(2)
      expect(merged.mcpServers?.existing).toBeDefined()
      expect(merged.mcpServers?.newserver).toBeDefined()
    })

    test("empty message config preserves base config", () => {
      const baseConfig: Mcp.ConfigType = {
        mcpServers: {
          server1: { command: "base", args: [] },
        }
      }
      
      const messageConfig = {}
      
      const merged: Mcp.ConfigType = {
        mcpServers: {
          ...baseConfig.mcpServers,
          ...messageConfig,
        }
      }
      
      expect(merged.mcpServers?.server1).toEqual({ command: "base", args: [] })
    })
  })
})
