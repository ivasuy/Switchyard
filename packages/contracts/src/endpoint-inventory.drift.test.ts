import { describe, expect, it } from "vitest";
import { createDaemonApp } from "../../../apps/daemon/src/app.js";
import { HOSTED_SERVER_ROUTE_INVENTORY, LOCAL_DAEMON_ROUTE_INVENTORY } from "./endpoint-inventory.js";

function collectMethodPathSet(printRoutes: string): Set<string> {
  const set = new Set<string>();
  const stack: string[] = [];
  for (const line of printRoutes.split(/\r?\n/)) {
    const marker = line.indexOf("── ");
    if (marker < 0) continue;
    const level = Math.max(0, Math.floor(marker / 4));
    const rest = line.slice(marker + 3);
    const match = rest.match(/^(\S+)\s+\((.+)\)$/);
    if (!match || !match[1] || !match[2]) continue;
    const rawPath = match[1];
    const methods = match[2].split(",").map((method) => method.trim()).filter(Boolean);

    const fullPath = level === 0 ? rawPath : joinPath(stack[level - 1] ?? "", rawPath);
    stack[level] = fullPath;

    for (const method of methods) {
      if (method === "HEAD") continue;
      set.add(`${method.toUpperCase()} ${fullPath}`);
    }
  }
  return set;
}

function joinPath(parent: string, child: string): string {
  if (!parent) return child;
  if (child === "/") return parent;
  const normalizedParent = parent.endsWith("/") ? parent.slice(0, -1) : parent;
  return `${normalizedParent}${child}`;
}

describe("local daemon route inventory", () => {
  it("keeps local drift anchored to daemon-only surface", () => {
    expect(LOCAL_DAEMON_ROUTE_INVENTORY.every((entry) => entry.surface === "local_daemon")).toBe(true);
    expect(HOSTED_SERVER_ROUTE_INVENTORY.every((entry) => entry.surface === "hosted_server")).toBe(true);
  });

  it("matches createDaemonApp route registration", async () => {
    const app = await createDaemonApp();
    try {
      await app.ready();
      const routes = collectMethodPathSet(app.printRoutes({ commonPrefix: false }));
      const inventory = new Set(
        LOCAL_DAEMON_ROUTE_INVENTORY.map((entry) => `${entry.method.toUpperCase()} ${entry.path}`)
      );

      expect(inventory).toEqual(routes);
    } finally {
      await app.close();
    }
  });
});
