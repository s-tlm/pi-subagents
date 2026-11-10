/**
 * schedule-store-wiring.test.ts — The booted extension's schedule files on
 * session start.
 *
 * Covers what the unit tests can't: that session_start moves a legacy store
 * into the agent folder and claims it for this process.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import subagentsExtension from "../src/index.js";
import { legacyStorePath, resolveStorePath } from "../src/schedule-store.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

const SESSION_ID = "store-wiring-session";

describe("scheduler → schedule store", () => {
  it("moves a legacy store on session start and claims it for this process", async () => {
    const hermetic = hermeticDir();
    vi.stubEnv("HERDR_PANE_ID", "w1:p1");
    try {
      const legacy = legacyStorePath(hermetic.dir, SESSION_ID);
      const inTwoHours = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(legacy, JSON.stringify({
        version: 1,
        jobs: [{
          id: "old", name: "legacy check", description: "legacy check", schedule: inTwoHours,
          scheduleType: "once", subagent_type: "general-purpose", prompt: "p",
          enabled: true, createdAt: new Date().toISOString(), runCount: 0,
        }],
      }));

      const { pi, lifecycle } = makePi();
      subagentsExtension(pi);
      const c = ctx({
        cwd: hermetic.dir,
        sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
      });
      await lifecycle.get("session_start")?.({}, c);
      await lifecycle.get("session_shutdown")?.();

      expect(existsSync(legacy)).toBe(false);
      const stored = JSON.parse(readFileSync(resolveStorePath(SESSION_ID), "utf-8"));
      expect(stored.jobs.map((j: { id: string }) => j.id)).toEqual(["old"]);
      expect(stored.owner).toEqual({ cwd: hermetic.dir, pid: process.pid, herdrPaneId: "w1:p1" });
    } finally {
      vi.unstubAllEnvs();
      hermetic.restore();
    }
  });
});
