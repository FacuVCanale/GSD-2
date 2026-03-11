import { homedir } from 'os'
import { join } from 'path'

export const appRoot = join(homedir(), '.gsd')
export const agentDir = join(appRoot, 'agent')
/**
 * Legacy sessions directory (flat, no per-cwd partitioning).
 * Kept for migration — new sessions use Pi's default per-cwd structure.
 */
export const legacySessionsDir = join(appRoot, 'sessions')
export const authFilePath = join(agentDir, 'auth.json')
