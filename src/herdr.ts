/**
 * herdr.ts — Shows a session's next scheduled run on its herdr agent row.
 *
 * Reports a `schedule` pane token through herdr's socket API. Herdr draws it
 * wherever a `[ui.sidebar.agents]` row names `$schedule`. Outside herdr
 * (`HERDR_ENV` unset) reporting does nothing.
 */

import { createConnection } from "node:net";

/** Herdr trims token values to this many code points. */
const LABEL_MAX = 80;
const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SOURCE = "user:pi-subagents";
const TIMEOUT_MS = 1000;

export interface LabelJob {
  name: string;
  /** ISO time of the next fire; undefined when the job is disabled or spent. */
  nextRun?: string;
}

/**
 * `⏰ Fri 08:00 <name> +N` for the soonest job, where N counts the other armed
 * jobs. Runs six or more days out show the date instead of the weekday, so a
 * weekday never means two different days. Empty when nothing is armed.
 */
export function formatScheduleLabel(jobs: LabelJob[], now = new Date()): string {
  const armed = jobs
    .filter((j): j is Required<LabelJob> => j.nextRun !== undefined)
    .sort((a, b) => Date.parse(a.nextRun) - Date.parse(b.nextRun));
  if (armed.length === 0) return "";

  const next = new Date(armed[0].nextRun);
  const day = next.getTime() - now.getTime() < 6 * DAY_MS
    ? WEEKDAYS[next.getDay()]
    : `${next.getDate()} ${MONTHS[next.getMonth()]}`;
  const time = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  const prefix = `⏰ ${day} ${time} `;
  const suffix = armed.length > 1 ? ` +${armed.length - 1}` : "";

  // Shorten the name, not the count: herdr's own cap would cut the suffix off.
  // Herdr counts code points, hence the spread; the prefix and suffix are all BMP.
  const room = LABEL_MAX - prefix.length - suffix.length;
  const chars = [...armed[0].name];
  const name = chars.length > room ? `${chars.slice(0, room - 1).join("")}…` : armed[0].name;
  return `${prefix}${name}${suffix}`;
}

/**
 * Returns a function that sets this pane's `schedule` token, or clears it when
 * given "". It skips a label it already sent, and always sends the first one,
 * so a new runtime replaces whatever the last one left behind. Sends go one at
 * a time, so herdr can't apply an older label last. Never rejects: the label
 * is display-only, so a missing or slow herdr is ignored.
 */
export function createScheduleLabelReporter(env: NodeJS.ProcessEnv = process.env): (label: string) => Promise<void> {
  const socketPath = env.HERDR_SOCKET_PATH;
  const paneId = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !socketPath || !paneId) return async () => {};
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  let lastSent: string | undefined;
  let seq = 0;
  let queue = Promise.resolve();

  const send = (request: unknown) => new Promise<void>((resolve) => {
    const socket = createConnection(endpoint);
    const done = () => {
      socket.destroy();
      resolve();
    };
    socket.setTimeout(TIMEOUT_MS, done);
    socket.on("error", done);
    socket.on("end", done);
    socket.on("data", done);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });

  return (label) => {
    if (label === lastSent) return queue;
    lastSent = label;
    const request = {
      id: `${SOURCE}:${process.pid}:${++seq}`,
      method: "pane.report_metadata",
      params: { pane_id: paneId, source: SOURCE, tokens: { schedule: label || null } },
    };
    queue = queue.then(() => send(request));
    return queue;
  };
}
