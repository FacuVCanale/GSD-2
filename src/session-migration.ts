/**
 * One-time migration: move session files from the legacy flat directory
 * (~/.gsd/sessions/) to Pi's per-cwd directory structure
 * (~/.gsd/agent/sessions/<encoded-cwd>/).
 *
 * Previous versions of GSD stored all sessions in a single flat directory,
 * which broke SessionManager.listAll() (the "All" scope in /resume) because
 * it expects per-cwd subdirectories.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync } from 'fs'
import { join } from 'path'
import { legacySessionsDir, agentDir } from './app-paths.js'

/**
 * Encode a cwd into the safe directory name Pi uses for per-cwd session dirs.
 * Must match Pi's internal getDefaultSessionDir() encoding exactly.
 */
function encodeCwdForSessionDir(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/**
 * Extract the cwd from a session file's header line (first JSONL line).
 * Returns null if the file is unreadable or has no valid session header.
 */
function extractCwdFromSession(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    const firstLine = content.split('\n')[0]
    if (!firstLine) return null
    const header = JSON.parse(firstLine)
    if (header.type !== 'session' || typeof header.id !== 'string') return null
    return typeof header.cwd === 'string' ? header.cwd : null
  } catch {
    return null
  }
}

/**
 * Core migration logic with injectable paths (for testing).
 */
export function migrateLegacySessionsFrom(legacyDir: string, targetAgentDir: string): void {
  if (!existsSync(legacyDir)) return

  let files: string[]
  try {
    files = readdirSync(legacyDir).filter(f => f.endsWith('.jsonl'))
  } catch {
    return
  }

  if (files.length === 0) {
    try { rmdirSync(legacyDir) } catch { /* non-empty or permission error */ }
    return
  }

  const sessionsBaseDir = join(targetAgentDir, 'sessions')
  let migrated = 0

  for (const file of files) {
    const srcPath = join(legacyDir, file)
    const cwd = extractCwdFromSession(srcPath)
    if (!cwd) continue

    const cwdDir = join(sessionsBaseDir, encodeCwdForSessionDir(cwd))
    if (!existsSync(cwdDir)) {
      mkdirSync(cwdDir, { recursive: true })
    }

    const destPath = join(cwdDir, file)
    if (existsSync(destPath)) continue

    try {
      renameSync(srcPath, destPath)
      migrated++
    } catch {
      // Cross-device move or permission issue — skip this file
    }
  }

  try {
    const remaining = readdirSync(legacyDir)
    if (remaining.length === 0) {
      rmdirSync(legacyDir)
    }
  } catch { /* ignore */ }

  if (migrated > 0) {
    process.stderr.write(`[gsd] Migrated ${migrated} session${migrated === 1 ? '' : 's'} to new directory structure\n`)
  }
}

/**
 * Migrate legacy session files using default GSD paths.
 * Called from cli.ts on startup.
 */
export function migrateLegacySessions(): void {
  migrateLegacySessionsFrom(legacySessionsDir, agentDir)
}
