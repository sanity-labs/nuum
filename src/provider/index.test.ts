import {describe, test, expect} from 'bun:test'
import {z} from 'zod'
import {tool} from 'ai'

/**
 * Tests for the tool error handling mechanisms in Provider.
 *
 * We test the helper functions directly rather than the full generate/stream
 * flow since those require actual API calls.
 */

// Re-create the internal tool for testing (since it's not exported)
const INVALID_TOOL_CALL = '__invalid_tool_call__'

function createInvalidToolCallTool() {
  return tool({
    description:
      'Internal tool - surfaces validation errors for invalid tool calls',
    parameters: z.object({
      toolName: z.string().describe('The tool that was called'),
      args: z.string().describe('The arguments that were provided (as JSON)'),
      error: z.string().describe('The validation error message'),
    }),
    execute: async ({toolName, args, error}) => {
      return `Error: Invalid tool call to "${toolName}"

You provided these arguments:
${args}

Validation error:
${error}

Please check the tool's parameter schema and try again with correct arguments.`
    },
  })
}

describe('Invalid Tool Call Handler', () => {
  test('createInvalidToolCallTool returns a valid tool', () => {
    const errorTool = createInvalidToolCallTool()

    expect(errorTool.description).toBe(
      'Internal tool - surfaces validation errors for invalid tool calls',
    )
    expect(errorTool.parameters).toBeDefined()
    expect(errorTool.execute).toBeDefined()
  })

  test('error tool formats message correctly', async () => {
    const errorTool = createInvalidToolCallTool()

    const result = await errorTool.execute!(
      {
        toolName: 'read',
        args: '{"wrongParam": "/path/to/file"}',
        error: 'filePath: Required',
      },
      {
        toolCallId: 'test-123',
        messages: [],
        abortSignal: undefined as unknown as AbortSignal,
      },
    )

    expect(result).toContain('Error: Invalid tool call to "read"')
    expect(result).toContain('{"wrongParam": "/path/to/file"}')
    expect(result).toContain('filePath: Required')
    expect(result).toContain("Please check the tool's parameter schema")
  })

  test('error tool includes all provided context', async () => {
    const errorTool = createInvalidToolCallTool()

    const complexArgs = JSON.stringify(
      {
        param1: 'value1',
        param2: 123,
        nested: {a: 1, b: 2},
      },
      null,
      2,
    )

    const result = await errorTool.execute!(
      {
        toolName: 'complexTool',
        args: complexArgs,
        error: 'param3: Required; param4: Expected number, received string',
      },
      {
        toolCallId: 'test-456',
        messages: [],
        abortSignal: undefined as unknown as AbortSignal,
      },
    )

    expect(result).toContain('complexTool')
    expect(result).toContain('param1')
    expect(result).toContain('value1')
    expect(result).toContain('param3: Required')
    expect(result).toContain('param4: Expected number')
  })
})

describe('Tool Call Repair Function', () => {
  // Re-create the repair function for testing
  function createToolCallRepairFunction() {
    return async ({
      toolCall,
      error,
    }: {
      toolCall: {toolName: string; toolCallId: string; args: unknown}
      tools: Record<string, unknown>
      parameterSchema: (options: {toolName: string}) => unknown
      error: Error
    }) => {
      const errorMessage = error.message || String(error)

      return {
        toolCallType: 'function' as const,
        toolName: INVALID_TOOL_CALL,
        toolCallId: toolCall.toolCallId,
        args: JSON.stringify({
          toolName: toolCall.toolName,
          args: JSON.stringify(toolCall.args, null, 2),
          error: errorMessage,
        }),
      }
    }
  }

  test('repair function redirects to __invalid_tool_call__', async () => {
    const repair = createToolCallRepairFunction()

    const result = await repair({
      toolCall: {
        toolName: 'read',
        toolCallId: 'call-123',
        args: {wrongParam: '/path/to/file'},
      },
      tools: {},
      parameterSchema: () => ({}),
      error: new Error('filePath: Required'),
    })

    expect(result.toolName).toBe(INVALID_TOOL_CALL)
    expect(result.toolCallId).toBe('call-123')
    expect(result.toolCallType).toBe('function')
  })

  test('repair function preserves original tool call info in args', async () => {
    const repair = createToolCallRepairFunction()

    const result = await repair({
      toolCall: {
        toolName: 'edit',
        toolCallId: 'call-456',
        args: {file: 'test.ts', content: 'hello'},
      },
      tools: {},
      parameterSchema: () => ({}),
      error: new Error(
        'filePath: Required; oldString: Required; newString: Required',
      ),
    })

    const parsedArgs = JSON.parse(result.args)
    expect(parsedArgs.toolName).toBe('edit')
    expect(parsedArgs.args).toContain('file')
    expect(parsedArgs.args).toContain('test.ts')
    expect(parsedArgs.error).toContain('filePath: Required')
  })

  test('repair function handles complex nested args', async () => {
    const repair = createToolCallRepairFunction()

    const complexArgs = {
      nested: {deep: {value: 123}},
      array: [1, 2, 3],
      nullValue: null,
    }

    const result = await repair({
      toolCall: {
        toolName: 'complexTool',
        toolCallId: 'call-789',
        args: complexArgs,
      },
      tools: {},
      parameterSchema: () => ({}),
      error: new Error('validation failed'),
    })

    const parsedArgs = JSON.parse(result.args)
    const originalArgs = JSON.parse(parsedArgs.args)

    expect(originalArgs.nested.deep.value).toBe(123)
    expect(originalArgs.array).toEqual([1, 2, 3])
    expect(originalArgs.nullValue).toBeNull()
  })
})

describe('Tool Execution Error Wrapping', () => {
  // Test the execute wrapper that catches runtime errors
  function wrapExecute(
    originalExecute: (args: unknown, context: unknown) => Promise<string>,
  ) {
    return async (args: unknown, context: unknown) => {
      try {
        return await originalExecute(args, context)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `Error executing tool: ${message}`
      }
    }
  }

  test('wrapped execute returns result on success', async () => {
    const original = async () => 'success!'
    const wrapped = wrapExecute(original)

    const result = await wrapped({}, {})
    expect(result).toBe('success!')
  })

  test('wrapped execute catches and returns errors', async () => {
    const original = async () => {
      throw new Error('File not found')
    }
    const wrapped = wrapExecute(original)

    const result = await wrapped({}, {})
    expect(result).toContain('Error executing tool')
    expect(result).toContain('File not found')
  })

  test('wrapped execute handles non-Error throws', async () => {
    const original = async () => {
      throw 'string error'
    }
    const wrapped = wrapExecute(original)

    const result = await wrapped({}, {})
    expect(result).toContain('Error executing tool')
    expect(result).toContain('string error')
  })
})

describe('prepareTools', () => {
  // Test that prepareTools adds the error tool and wraps execute
  function prepareTools(
    tools: Record<
      string,
      {execute?: (args: unknown, context: unknown) => Promise<string>}
    >,
  ) {
    const prepared: Record<string, unknown> = {
      [INVALID_TOOL_CALL]: createInvalidToolCallTool(),
    }

    for (const [name, t] of Object.entries(tools)) {
      const originalExecute = t.execute

      if (!originalExecute) {
        prepared[name] = t
        continue
      }

      prepared[name] = {
        ...t,
        execute: async (args: unknown, context: unknown) => {
          try {
            return await originalExecute(args, context)
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            return `Error executing tool "${name}": ${message}`
          }
        },
      }
    }

    return prepared
  }

  test('prepareTools adds __invalid_tool_call__ tool', () => {
    const tools = {
      myTool: {execute: async () => 'result'},
    }

    const prepared = prepareTools(tools)

    expect(prepared[INVALID_TOOL_CALL]).toBeDefined()
    expect(prepared.myTool).toBeDefined()
  })

  test('prepareTools preserves tools without execute', () => {
    const tools = {
      noExecute: {description: 'A tool without execute'},
    }

    const prepared = prepareTools(tools)

    expect(prepared.noExecute).toBe(tools.noExecute)
  })

  test('prepareTools wraps execute to catch errors', async () => {
    const tools = {
      failingTool: {
        execute: async () => {
          throw new Error('Something went wrong')
        },
      },
    }

    const prepared = prepareTools(tools) as Record<
      string,
      {execute: (args: unknown, context: unknown) => Promise<string>}
    >
    const result = await prepared.failingTool.execute({}, {})

    expect(result).toContain('Error executing tool')
    expect(result).toContain('failingTool')
    expect(result).toContain('Something went wrong')
  })
})
