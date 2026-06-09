import { describe, expect, it } from "vitest";
import { AdapterProtocolError } from "@switchyard/core";
import { runtimeModeSchema } from "@switchyard/contracts";
import {
  CursorAgentAdapter,
  OpenClawAdapter,
  PaperclipAdapter
} from "../src/index.js";

describe("deferred adapter scaffolds", () => {
  it("exposes parseable runtime manifests for Cursor OpenClaw and Paperclip", () => {
    for (const adapter of [
      new CursorAgentAdapter({
        probeVersion: async () => ({
          ok: false,
          version: null,
          reasonCode: "cursor_binary_missing",
          message: "missing"
        })
      }),
      new OpenClawAdapter(),
      new PaperclipAdapter()
    ]) {
      const manifest = adapter.manifest;
      const parsed = runtimeModeSchema.parse({
        id: manifest.runtimeModeId,
        slug: manifest.runtimeModeSlug,
        name: manifest.name,
        providerId: manifest.providerId,
        runtimeId: manifest.runtimeId,
        adapterId: manifest.adapterId,
        adapterType: manifest.adapterType,
        kind: manifest.kind,
        status: "unknown",
        capabilities: manifest.capabilities,
        limitations: manifest.limitations,
        placement: manifest.placement,
        availability: {
          state: "unknown",
          canRun: false,
          installed: false,
          auth: "unknown",
          version: null,
          checkedAt: "2026-06-06T00:00:00.000Z",
          reasonCode: "not_checked",
          message: "not checked"
        },
        docsPath: manifest.docsPath,
        createdAt: "2026-06-06T00:00:00.000Z",
        updatedAt: "2026-06-06T00:00:00.000Z"
      });
      expect(parsed.slug).toBe(manifest.runtimeModeSlug);
      expect(manifest.limitations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: expect.stringMatching(/unverified|start_disabled_until_verified/) })
        ])
      );
    }
  });

  it("maps Cursor check to partial when binary exists but execution remains blocked", async () => {
    const adapter = new CursorAgentAdapter({
      probeVersion: async () => ({
        ok: true,
        version: "cursor-agent 2026.05.07-test",
        reasonCode: null,
        message: null
      })
    });
    const check = await adapter.check();
    expect(check.ok).toBe(true);
    expect(check.details?.["availability"]).toMatchObject({
      state: "partial",
      canRun: false,
      installed: true,
      version: "cursor-agent 2026.05.07-test",
      reasonCode: "cursor_stream_shape_unverified"
    });
  });

  it("maps missing wrapper base URLs to config-missing reason codes", async () => {
    const openclaw = await new OpenClawAdapter().check();
    const paperclip = await new PaperclipAdapter().check();

    expect(openclaw.ok).toBe(false);
    expect(openclaw.details?.["availability"]).toMatchObject({
      reasonCode: "openclaw_config_missing",
      canRun: false
    });
    expect(paperclip.ok).toBe(false);
    expect(paperclip.details?.["availability"]).toMatchObject({
      reasonCode: "paperclip_config_missing",
      canRun: false
    });
  });

  it("denies start before upstream contracts are verified", async () => {
    for (const adapter of [
      new CursorAgentAdapter({
        probeVersion: async () => ({
          ok: false,
          version: null,
          reasonCode: "cursor_binary_missing",
          message: "missing"
        })
      }),
      new OpenClawAdapter(),
      new PaperclipAdapter()
    ]) {
      await expect(adapter.start({})).rejects.toBeInstanceOf(AdapterProtocolError);
    }
  });
});
