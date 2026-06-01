import { describe, expect, it } from "vitest";
import { HOSTED_SERVER_ROUTE_INVENTORY, LOCAL_DAEMON_ROUTE_INVENTORY } from "./endpoint-inventory.js";

const FORBIDDEN_PUBLIC_ROUTE_PREFIX =
  /^\/(exec|shell|process|command|pty|terminal|sandbox|browser|search|github|fetch|repo|dashboard|tui)(\/|$)/;
const FORBIDDEN_OPERATION_TOKENS = [
  "sandbox",
  "terminal",
  "exec",
  "pty",
  "shell",
  "process",
  "command",
  "browser",
  "search",
  "github",
  "fetch",
  "repo",
  "dashboard",
  "tui",
  "genericProcess",
  "arbitraryProcess"
];

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
    const daemonModule = await import("../../../apps/daemon/src/app.js").catch(() => null);
    if (!daemonModule?.createDaemonApp) {
      const localKeys = new Set(
        LOCAL_DAEMON_ROUTE_INVENTORY.map((entry) => `${entry.method.toUpperCase()} ${entry.path}`)
      );
      expect(localKeys.size).toBe(LOCAL_DAEMON_ROUTE_INVENTORY.length);
      expect(localKeys.has("POST /tools/invocations")).toBe(true);
      return;
    }

    const app = await daemonModule.createDaemonApp();
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

  it("keeps local and hosted inventory free of forbidden public execution/dashboard routes", () => {
    for (const entry of [...LOCAL_DAEMON_ROUTE_INVENTORY, ...HOSTED_SERVER_ROUTE_INVENTORY]) {
      const lowerPath = entry.path.toLowerCase();
      expect(FORBIDDEN_PUBLIC_ROUTE_PREFIX.test(lowerPath)).toBe(false);
      expect(entry.path).not.toMatch(/^\/(dashboard|tui)(\/|$)/i);
      if (entry.path === "/memory/search" && entry.operationId === "searchMemory") {
        continue;
      }
      expect(FORBIDDEN_OPERATION_TOKENS.some((token) => entry.operationId.toLowerCase().includes(token))).toBe(false);
    }
  });

  it("includes only the hosted R22 tool invocation and approval subset", () => {
    const hosted = HOSTED_SERVER_ROUTE_INVENTORY.map((entry) => `${entry.method.toUpperCase()} ${entry.path}`);
    expect(hosted).toContain("POST /tools/invocations");
    expect(hosted).toContain("GET /tools/invocations");
    expect(hosted).toContain("GET /tools/invocations/:id");
    expect(hosted).toContain("GET /approvals");
    expect(hosted).toContain("GET /approvals/:id");
    expect(hosted).toContain("POST /approvals/:id/approve");
    expect(hosted).toContain("POST /approvals/:id/reject");
    expect(hosted).not.toContain("POST /approvals");
  });
});
