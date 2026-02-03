/**
 * Environment context for the current turn.
 *
 * Stores environment variables received from CAST per-message.
 * Used by tools (bash, grep, etc.) when spawning child processes.
 *
 * This is a module-level singleton since Nuum runs as a single-agent subprocess.
 * Each message can update the environment, and it's applied to subsequent spawns.
 */

let currentEnvironment: Record<string, string> = {}

/**
 * Set the environment for the current turn.
 * Called by the server when processing a user message.
 */
export function setEnvironment(env: Record<string, string>): void {
  currentEnvironment = env
}

/**
 * Get the current environment.
 * Used by tools when spawning child processes.
 */
export function getEnvironment(): Record<string, string> {
  return currentEnvironment
}

/**
 * Get merged environment for spawning child processes.
 * Combines process.env with the current turn's environment.
 * Turn environment takes precedence over process.env.
 */
export function getSpawnEnvironment(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ...currentEnvironment,
  }
}
