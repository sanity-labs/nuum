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
  })
})
