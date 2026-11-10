/**
 * fake-herdr.ts — A stand-in for herdr's socket API: a Unix socket server in a
 * temp dir that records each request and answers it like the real server.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeHerdr {
  path: string;
  requests: any[];
  /** Most requests received and not yet answered at once. */
  maxInFlight: () => number;
  close: () => Promise<void>;
}

export async function fakeHerdr(opts: { reply?: boolean } = {}): Promise<FakeHerdr> {
  const dir = mkdtempSync(join(tmpdir(), "herdr-"));
  const path = join(dir, "herdr.sock");
  const requests: any[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server: Server = createServer((socket) => {
    socket.on("data", (buf) => {
      const request = JSON.parse(buf.toString());
      requests.push(request);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      if (opts.reply === false) return;
      // A short delay, so overlapping sends would show up in maxInFlight.
      setTimeout(() => {
        inFlight--;
        socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }, 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    requests,
    maxInFlight: () => maxInFlight,
    close: async () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The environment herdr gives a pane, pointed at `path`. */
export const herdrEnv = (path: string) => ({ HERDR_ENV: "1", HERDR_SOCKET_PATH: path, HERDR_PANE_ID: "w1:p1" });
