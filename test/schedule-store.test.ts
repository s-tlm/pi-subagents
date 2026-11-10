/**
 * schedule-store.test.ts — Persistence + concurrency for ScheduleStore.
 *
 * Mirrors the patterns from pi-chonky-tasks's task-store testing: round-trip
 * load/save, parse-error self-heal, stale-lock recovery.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { legacyStorePath, migrateLegacyStore, resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
import type { ScheduledSubagent } from "../src/types.js";

function makeJob(overrides: Partial<ScheduledSubagent> = {}): ScheduledSubagent {
  return {
    id: "job-" + Math.random().toString(36).slice(2, 10),
    name: "test-job",
    description: "test",
    schedule: "5m",
    scheduleType: "interval",
    intervalMs: 5 * 60_000,
    subagent_type: "general-purpose",
    prompt: "hello",
    enabled: true,
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("ScheduleStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "schedule-store-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolveStorePath puts every session's store in the agent folder", () => {
    expect(resolveStorePath("abc123", "/agent")).toBe("/agent/subagent-schedules/abc123.json");
  });

  it("resolveStorePath defaults to PI_CODING_AGENT_DIR", () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp;
    try {
      expect(resolveStorePath("abc123")).toBe(join(tmp, "subagent-schedules", "abc123.json"));
    } finally {
      if (prev == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  it("legacyStorePath is the old per-project location", () => {
    expect(legacyStorePath("/repo", "abc123")).toBe("/repo/.pi/subagent-schedules/abc123.json");
  });

  describe("migrateLegacyStore", () => {
    it("moves a legacy store, creating the new folder", () => {
      const from = legacyStorePath(join(tmp, "repo"), "s");
      const to = resolveStorePath("s", join(tmp, "agent"));
      const legacy = new ScheduleStore(from);
      const job = makeJob();
      legacy.add(job);

      migrateLegacyStore(from, to);

      expect(existsSync(from)).toBe(false);
      expect(new ScheduleStore(to).list()).toEqual([job]);
    });

    it("never overwrites a store that already exists at the new path", () => {
      const from = join(tmp, "legacy.json");
      const to = join(tmp, "new.json");
      new ScheduleStore(from).add(makeJob({ id: "old" }));
      new ScheduleStore(to).add(makeJob({ id: "current" }));

      migrateLegacyStore(from, to);

      expect(new ScheduleStore(to).list().map((j) => j.id)).toEqual(["current"]);
      expect(existsSync(from)).toBe(true);
    });

    it("does nothing when there is no legacy store", () => {
      const to = join(tmp, "agent", "subagent-schedules", "s.json");
      migrateLegacyStore(join(tmp, "missing.json"), to);
      expect(existsSync(join(tmp, "agent"))).toBe(false);
    });
  });

  describe("claim", () => {
    const owner = { cwd: "/repo", pid: 4242, herdrPaneId: "w1:p1" };

    it("rewrites a non-empty store at once with the new owner", () => {
      const file = join(tmp, "s.json");
      new ScheduleStore(file).add(makeJob());

      new ScheduleStore(file).claim(owner);

      expect(JSON.parse(readFileSync(file, "utf-8")).owner).toEqual(owner);
    });

    it("does not create a file for an empty store", () => {
      const file = join(tmp, "s.json");
      new ScheduleStore(file).claim(owner);
      expect(existsSync(file)).toBe(false);
    });

    it("keeps the owner on later saves", () => {
      const file = join(tmp, "s.json");
      const store = new ScheduleStore(file);
      store.claim(owner);
      store.add(makeJob());
      expect(JSON.parse(readFileSync(file, "utf-8")).owner).toEqual(owner);
    });
  });

  it("starts empty and round-trips a job through add/list", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    expect(store.list()).toEqual([]);
    const job = makeJob();
    store.add(job);
    expect(store.list()).toEqual([job]);

    // New instance on same file — verifies persistence
    const fresh = new ScheduleStore(join(tmp, "s.json"));
    expect(fresh.list()).toEqual([job]);
  });

  it("update returns merged record and persists the patch", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const job = makeJob({ name: "before" });
    store.add(job);

    const updated = store.update(job.id, { name: "after", runCount: 3 });
    expect(updated).toMatchObject({ id: job.id, name: "after", runCount: 3 });

    const fresh = new ScheduleStore(join(tmp, "s.json"));
    expect(fresh.list()[0]).toMatchObject({ name: "after", runCount: 3 });
  });

  it("update returns undefined for unknown id and does not create a record", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const r = store.update("nonexistent", { name: "x" });
    expect(r).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("remove returns true on existing job and false on missing", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const job = makeJob();
    store.add(job);
    expect(store.remove(job.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove(job.id)).toBe(false);
  });

  it("hasName excludes a given id (for rename safety)", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const job = makeJob({ name: "alpha" });
    store.add(job);
    expect(store.hasName("alpha")).toBe(true);
    expect(store.hasName("alpha", job.id)).toBe(false);  // excluded — own record
    expect(store.hasName("beta")).toBe(false);
  });

  it("uses atomic temp+rename — write produces final file, no .tmp leftover", () => {
    const file = join(tmp, "s.json");
    const store = new ScheduleStore(file);
    store.add(makeJob());
    expect(existsSync(file)).toBe(true);
    expect(existsSync(file + ".tmp")).toBe(false);
  });

  it("self-heals from a corrupt JSON file — load silently empties, next save rewrites", () => {
    const file = join(tmp, "s.json");
    writeFileSync(file, "{ this is not valid JSON");
    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);

    // Next mutation overwrites the broken file with healthy JSON
    store.add(makeJob({ id: "fresh" }));
    const data = JSON.parse(readFileSync(file, "utf-8"));
    expect(data.version).toBe(1);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].id).toBe("fresh");
  });

  it("recovers from a stale lock left by a dead process", () => {
    const file = join(tmp, "s.json");
    const lockFile = file + ".lock";
    // Simulate a stale lock file containing a non-existent PID.
    // PID 999_999_999 is virtually never a live process — kill -0 returns ESRCH.
    writeFileSync(lockFile, "999999999");

    const store = new ScheduleStore(file);
    // The mutation will detect the stale lock, unlink it, and proceed.
    expect(() => store.add(makeJob())).not.toThrow();
    expect(store.list()).toHaveLength(1);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("releases the lock after a successful mutation so subsequent ones don't deadlock", () => {
    const store = new ScheduleStore(join(tmp, "s.json"));
    const a = makeJob({ id: "a" });
    const b = makeJob({ id: "b" });
    store.add(a);
    store.add(b);  // would hang if the lock from the first add wasn't released
    expect(store.list().map(j => j.id).sort()).toEqual(["a", "b"]);
  });

  it("does not create the backing directory until a mutation persists", () => {
    const dir = join(tmp, ".pi", "subagent-schedules");
    const file = join(dir, "sess.json");

    // Constructing + read-only use must not touch the filesystem.
    const store = new ScheduleStore(file);
    expect(store.list()).toEqual([]);
    expect(existsSync(dir)).toBe(false);

    // First mutation lazily creates the directory.
    store.add(makeJob());
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("no-op update/remove of an unknown id never creates the backing directory", () => {
    const dir = join(tmp, ".pi", "subagent-schedules");
    const file = join(dir, "sess.json");
    const store = new ScheduleStore(file);

    expect(store.update("nonexistent", { name: "x" })).toBeUndefined();
    expect(store.remove("nonexistent")).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("deleteFileIfEmpty unlinks file only when no jobs remain", () => {
    const file = join(tmp, "s.json");
    const store = new ScheduleStore(file);
    const job = makeJob();
    store.add(job);
    store.deleteFileIfEmpty();  // not empty — should be a no-op
    expect(existsSync(file)).toBe(true);

    store.remove(job.id);
    store.deleteFileIfEmpty();
    expect(existsSync(file)).toBe(false);
  });
});
