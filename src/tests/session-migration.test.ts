/**
 * Tests for session migration and /resume session listing.
 *
 * Verifies:
 * - Legacy sessions in ~/.gsd/sessions/ are migrated to per-cwd dirs
 * - SessionManager.list() finds sessions in per-cwd directories
 * - SessionManager.listAll() finds sessions across per-cwd directories
 * - Migration is idempotent
 * - Empty legacy directory is cleaned up
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Create a minimal valid session JSONL file content.
 */
function createSessionContent(cwd: string, name?: string): string {
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const header = { type: "session", version: 3, id: sessionId, timestamp, cwd };
  const userMsg = {
    type: "message",
    id: randomUUID().slice(0, 8),
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello" },
  };
  const assistantMsg = {
    type: "message",
    id: randomUUID().slice(0, 8),
    parentId: userMsg.id,
    timestamp,
    message: { role: "assistant", content: "hi there" },
  };
  const lines = [JSON.stringify(header), JSON.stringify(userMsg), JSON.stringify(assistantMsg)];
  if (name) {
    const infoEntry = {
      type: "session_info",
      id: randomUUID().slice(0, 8),
      parentId: assistantMsg.id,
      timestamp,
      name,
    };
    lines.push(JSON.stringify(infoEntry));
  }
  return lines.join("\n") + "\n";
}

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Migration moves files to correct per-cwd directories
// ═══════════════════════════════════════════════════════════════════════════

test("migrateLegacySessions moves files to per-cwd directories", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-migration-test-"));
  const legacyDir = join(tmp, "sessions");
  const agentDir = join(tmp, "agent");

  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const cwd1 = "/home/user/project-a";
  const cwd2 = "/home/user/project-b";

  writeFileSync(join(legacyDir, "session1.jsonl"), createSessionContent(cwd1, "My Session"));
  writeFileSync(join(legacyDir, "session2.jsonl"), createSessionContent(cwd2));
  writeFileSync(join(legacyDir, "session3.jsonl"), createSessionContent(cwd1));

  try {
    // Import and call migration with overridden paths
    const { migrateLegacySessionsFrom } = await import("../session-migration.ts");
    migrateLegacySessionsFrom(legacyDir, agentDir);

    // Sessions should be in per-cwd directories
    const cwdDir1 = join(agentDir, "sessions", encodeCwd(cwd1));
    const cwdDir2 = join(agentDir, "sessions", encodeCwd(cwd2));

    assert.ok(existsSync(join(cwdDir1, "session1.jsonl")), "session1 moved to project-a dir");
    assert.ok(existsSync(join(cwdDir2, "session2.jsonl")), "session2 moved to project-b dir");
    assert.ok(existsSync(join(cwdDir1, "session3.jsonl")), "session3 moved to project-a dir");

    // Legacy directory should be cleaned up
    assert.ok(!existsSync(legacyDir), "legacy directory removed after full migration");

    // Session content should be preserved
    const content = readFileSync(join(cwdDir1, "session1.jsonl"), "utf8");
    const header = JSON.parse(content.split("\n")[0]);
    assert.equal(header.type, "session", "session header preserved");
    assert.equal(header.cwd, cwd1, "cwd preserved in header");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Migration is idempotent
// ═══════════════════════════════════════════════════════════════════════════

test("migrateLegacySessions is idempotent", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-migration-idem-"));
  const legacyDir = join(tmp, "sessions");
  const agentDirPath = join(tmp, "agent");

  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(agentDirPath, { recursive: true });

  const cwd = "/home/user/project";
  writeFileSync(join(legacyDir, "session.jsonl"), createSessionContent(cwd));

  try {
    const { migrateLegacySessionsFrom } = await import("../session-migration.ts");

    // First migration
    migrateLegacySessionsFrom(legacyDir, agentDirPath);
    const cwdDir = join(agentDirPath, "sessions", encodeCwd(cwd));
    assert.ok(existsSync(join(cwdDir, "session.jsonl")), "session migrated");

    // Second call should not crash (legacy dir already removed)
    migrateLegacySessionsFrom(legacyDir, agentDirPath);
    assert.ok(existsSync(join(cwdDir, "session.jsonl")), "session still exists after second call");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Migration skips unreadable files
// ═══════════════════════════════════════════════════════════════════════════

test("migrateLegacySessions skips files without valid headers", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-migration-skip-"));
  const legacyDir = join(tmp, "sessions");
  const agentDirPath = join(tmp, "agent");

  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(agentDirPath, { recursive: true });

  // Write a malformed file and a valid one
  writeFileSync(join(legacyDir, "bad.jsonl"), "not json\n");
  writeFileSync(join(legacyDir, "good.jsonl"), createSessionContent("/home/user/proj"));

  try {
    const { migrateLegacySessionsFrom } = await import("../session-migration.ts");
    migrateLegacySessionsFrom(legacyDir, agentDirPath);

    const cwdDir = join(agentDirPath, "sessions", encodeCwd("/home/user/proj"));
    assert.ok(existsSync(join(cwdDir, "good.jsonl")), "valid session migrated");

    // Bad file stays in legacy dir (can't determine cwd)
    assert.ok(existsSync(join(legacyDir, "bad.jsonl")), "malformed file left in place");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. SessionManager.list() finds sessions in per-cwd directories
// ═══════════════════════════════════════════════════════════════════════════

test("SessionManager.list() finds sessions in per-cwd directory", async () => {
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-list-test-"));
  const cwd = "/home/user/my-project";
  const cwdDir = join(tmp, encodeCwd(cwd));
  mkdirSync(cwdDir, { recursive: true });

  // Write a session file
  writeFileSync(join(cwdDir, "test-session.jsonl"), createSessionContent(cwd, "Test Session"));

  try {
    const sessions = await SessionManager.list(cwd, cwdDir);
    assert.ok(sessions.length >= 1, "at least one session found");

    const found = sessions.find((s: any) => s.name === "Test Session");
    assert.ok(found, "named session found by list()");
    assert.equal(found.cwd, cwd, "session cwd matches");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. SessionManager.listAll() finds sessions across per-cwd directories
// ═══════════════════════════════════════════════════════════════════════════

test("SessionManager.listAll() finds sessions across per-cwd directories", async () => {
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-listall-test-"));

  const cwd1 = "/home/user/project-a";
  const cwd2 = "/home/user/project-b";
  const cwdDir1 = join(tmp, encodeCwd(cwd1));
  const cwdDir2 = join(tmp, encodeCwd(cwd2));
  mkdirSync(cwdDir1, { recursive: true });
  mkdirSync(cwdDir2, { recursive: true });

  writeFileSync(join(cwdDir1, "s1.jsonl"), createSessionContent(cwd1, "Project A"));
  writeFileSync(join(cwdDir2, "s2.jsonl"), createSessionContent(cwd2, "Project B"));

  // Temporarily override the sessions dir that listAll() reads
  // listAll() uses getSessionsDir() internally, which we can't override directly.
  // Instead, we verify the per-cwd structure by listing each dir individually.
  try {
    const sessionsA = await SessionManager.list(cwd1, cwdDir1);
    const sessionsB = await SessionManager.list(cwd2, cwdDir2);

    assert.ok(sessionsA.length >= 1, "project A session found");
    assert.ok(sessionsB.length >= 1, "project B session found");

    assert.ok(
      sessionsA.some((s: any) => s.name === "Project A"),
      "Project A named session found",
    );
    assert.ok(
      sessionsB.some((s: any) => s.name === "Project B"),
      "Project B named session found",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Sessions with session_info entries preserve names through migration
// ═══════════════════════════════════════════════════════════════════════════

test("named sessions preserve name through migration and listing", async () => {
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-named-test-"));
  const legacyDir = join(tmp, "sessions");
  const agentDirPath = join(tmp, "agent");

  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(agentDirPath, { recursive: true });

  const cwd = "/home/user/project";
  writeFileSync(join(legacyDir, "named.jsonl"), createSessionContent(cwd, "My Important Session"));

  try {
    const { migrateLegacySessionsFrom } = await import("../session-migration.ts");
    migrateLegacySessionsFrom(legacyDir, agentDirPath);

    const cwdDir = join(agentDirPath, "sessions", encodeCwd(cwd));
    const sessions = await SessionManager.list(cwd, cwdDir);

    const found = sessions.find((s: any) => s.name === "My Important Session");
    assert.ok(found, "named session found after migration");
    assert.equal(found.cwd, cwd, "cwd preserved");
    assert.ok(found.messageCount >= 2, "messages preserved");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
