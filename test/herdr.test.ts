/**
 * herdr.test.ts — The schedule label text, and how it reaches herdr's socket.
 *
 * The reporter talks to a fake herdr (see `helpers/fake-herdr.ts`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScheduleLabelReporter, formatScheduleLabel } from "../src/herdr.js";
import { type FakeHerdr, fakeHerdr, herdrEnv } from "./helpers/fake-herdr.js";

// Thursday 5 Nov 2026, 15:00 local time. Local constructors keep these tests
// independent of the machine's time zone.
const NOW = new Date(2026, 10, 5, 15, 0);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

describe("formatScheduleLabel", () => {
  it("is empty when no job is armed", () => {
    expect(formatScheduleLabel([], NOW)).toBe("");
    expect(formatScheduleLabel([{ name: "spent" }], NOW)).toBe("");
  });

  it("shows the weekday and time of a run within six days", () => {
    expect(formatScheduleLabel([{ name: "Check GAM sync", nextRun: at(6, 8) }], NOW))
      .toBe("⏰ Fri 08:00 Check GAM sync");
  });

  it("pads single-digit hours and minutes", () => {
    expect(formatScheduleLabel([{ name: "x", nextRun: at(5, 9, 5) }], NOW)).toBe("⏰ Thu 09:05 x");
  });

  it("shows the date for a run six or more days out", () => {
    expect(formatScheduleLabel([{ name: "x", nextRun: at(11, 15) }], NOW)).toBe("⏰ 11 Nov 15:00 x");
    expect(formatScheduleLabel([{ name: "x", nextRun: at(11, 14, 59) }], NOW)).toBe("⏰ Wed 14:59 x");
  });

  it("names the soonest job and counts the other armed ones", () => {
    const jobs = [
      { name: "later", nextRun: at(7, 9) },
      { name: "disabled" },
      { name: "soonest", nextRun: at(5, 18) },
      { name: "middle", nextRun: at(6, 9) },
    ];
    expect(formatScheduleLabel(jobs, NOW)).toBe("⏰ Thu 18:00 soonest +2");
  });

  it("shortens a long name so the label fits herdr's 80 characters with the count intact", () => {
    const jobs = [{ name: "a".repeat(200), nextRun: at(6, 8) }, { name: "b", nextRun: at(7, 8) }];
    const label = formatScheduleLabel(jobs, NOW);
    expect([...label]).toHaveLength(80);
    expect(label.endsWith("a… +1")).toBe(true);
  });

  it("counts characters, not UTF-16 units, when shortening", () => {
    const label = formatScheduleLabel([{ name: "🚀".repeat(100), nextRun: at(6, 8) }], NOW);
    expect([...label]).toHaveLength(80);
    expect(label.endsWith("🚀…")).toBe(true);
  });

  it("keeps a name that fits exactly", () => {
    const name = "n".repeat(80 - "⏰ Fri 08:00 ".length);
    expect(formatScheduleLabel([{ name, nextRun: at(6, 8) }], NOW)).toBe(`⏰ Fri 08:00 ${name}`);
  });
});

describe("createScheduleLabelReporter", () => {
  let herdr: FakeHerdr | undefined;

  afterEach(async () => {
    await herdr?.close();
    herdr = undefined;
  });

  it("sets the schedule token on this pane", async () => {
    herdr = await fakeHerdr();
    await createScheduleLabelReporter(herdrEnv(herdr.path))("⏰ Fri 08:00 x");
    expect(herdr.requests).toEqual([
      {
        id: expect.stringMatching(/^user:pi-subagents:\d+:1$/),
        method: "pane.report_metadata",
        params: { pane_id: "w1:p1", source: "user:pi-subagents", tokens: { schedule: "⏰ Fri 08:00 x" } },
      },
    ]);
  });

  it("sends an empty label as a clear, including the first one", async () => {
    herdr = await fakeHerdr();
    await createScheduleLabelReporter(herdrEnv(herdr.path))("");
    expect(herdr.requests.map((r) => r.params.tokens)).toEqual([{ schedule: null }]);
  });

  it("skips a label it already sent", async () => {
    herdr = await fakeHerdr();
    const report = createScheduleLabelReporter(herdrEnv(herdr.path));
    await report("a");
    await report("a");
    await report("b");
    await report("");
    await report("");
    expect(herdr.requests.map((r) => r.params.tokens.schedule)).toEqual(["a", "b", null]);
  });

  it("sends one label at a time, in call order", async () => {
    herdr = await fakeHerdr();
    const report = createScheduleLabelReporter(herdrEnv(herdr.path));
    void report("a");
    void report("b");
    await report("c");
    expect(herdr.requests.map((r) => r.params.tokens.schedule)).toEqual(["a", "b", "c"]);
    expect(herdr.maxInFlight()).toBe(1);
  });

  it("does nothing outside herdr", async () => {
    herdr = await fakeHerdr();
    const env = herdrEnv(herdr.path);
    await createScheduleLabelReporter({ ...env, HERDR_ENV: "" })("x");
    await createScheduleLabelReporter({ ...env, HERDR_PANE_ID: undefined })("x");
    await createScheduleLabelReporter({ ...env, HERDR_SOCKET_PATH: undefined })("x");
    expect(herdr.requests).toEqual([]);
  });

  it("resolves when herdr is not running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-"));
    try {
      await expect(createScheduleLabelReporter(herdrEnv(join(dir, "missing.sock")))("x")).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives up on a herdr that never answers, and still sends the next label", async () => {
    herdr = await fakeHerdr({ reply: false });
    const report = createScheduleLabelReporter(herdrEnv(herdr.path));
    await report("a");
    await report("b");
    expect(herdr.requests.map((r) => r.params.tokens.schedule)).toEqual(["a", "b"]);
  });
});
