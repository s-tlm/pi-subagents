/**
 * schedule-herdr-wiring.test.ts — The booted extension's schedule files and
 * herdr label, from session start to shutdown.
 *
 * Covers what the unit tests can't: that session_start moves a legacy store,
 * claims it and reports its label; that a new job reaches herdr through the
 * `subagents:scheduled` event; and that shutdown clears the label.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { formatScheduleLabel } from "../src/herdr.js";
import subagentsExtension from "../src/index.js";
import { legacyStorePath, resolveStorePath } from "../src/schedule-store.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";
import { fakeHerdr, herdrEnv } from "./helpers/fake-herdr.js";

const SESSION_ID = "herdr-wiring-session";

/** A working `pi.events`: makePi's stub never delivers, and the label rides on delivery. */
function eventBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit: (channel: string, data: unknown) => {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on: (channel: string, handler: (data: unknown) => void) => {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)?.add(handler);
      return () => handlers.get(channel)?.delete(handler);
    },
  };
}

describe("scheduler → herdr label", () => {
  it("labels the pane from a migrated store, follows new jobs, and clears on shutdown", async () => {
    const hermetic = hermeticDir();
    const herdr = await fakeHerdr();
    // The reporter reads the environment when the extension boots.
    for (const [key, value] of Object.entries(herdrEnv(herdr.path))) vi.stubEnv(key, value);
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

      const { pi, tools, lifecycle } = makePi();
      pi.events = eventBus();
      subagentsExtension(pi);
      const c = ctx({
        cwd: hermetic.dir,
        sessionManager: { getSessionId: vi.fn(() => SESSION_ID), getBranch: vi.fn(() => []) },
      });
      await lifecycle.get("session_start")?.({}, c);

      expect(existsSync(legacy)).toBe(false);
      const stored = JSON.parse(readFileSync(resolveStorePath(SESSION_ID), "utf-8"));
      expect(stored.jobs.map((j: { id: string }) => j.id)).toEqual(["old"]);
      expect(stored.owner).toEqual({ cwd: hermetic.dir, pid: process.pid, herdrPaneId: "w1:p1" });

      await tools.get("Agent").execute(
        "tc-sched",
        { prompt: "do it", description: "nightly sweep", subagent_type: "general-purpose", schedule: "+1m" },
        undefined,
        undefined,
        c,
      );
      await vi.waitFor(() => expect(herdr.requests).toHaveLength(2));

      await lifecycle.get("session_shutdown")?.();

      const labels = herdr.requests.map((r) => r.params.tokens.schedule);
      expect(labels[0]).toBe(formatScheduleLabel([{ name: "legacy check", nextRun: inTwoHours }]));
      expect(labels[1]).toMatch(/^⏰ \w{3} \d{2}:\d{2} nightly sweep \+1$/);
      expect(labels[2]).toBeNull();
      expect(labels).toHaveLength(3);
    } finally {
      vi.unstubAllEnvs();
      await herdr.close();
      hermetic.restore();
    }
  });
});
