import { describe, expect, it } from "vitest";
import type { SwitchyardEvent } from "@switchyard/contracts";
import {
  buildDebateChildRunKey,
  buildDebateChildRunMetadata,
  DebateRuntimeMatrixError,
  normalizeDebateRuntime
} from "../src/services/debate-runtime-matrix.js";
import {
  classifyDebateRuntimeOutputTiming,
  extractDebateRuntimeOutput
} from "../src/services/debate-output.js";

describe("debate real runtime helpers", () => {
  it("preserves fake deterministic defaults", () => {
    expect(normalizeDebateRuntime({ role: "affirmative" }, 0)).toEqual({
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      runtimeMode: "fake.deterministic",
      placement: "local",
      realRuntimeOptIn: false,
      isRealRuntime: false
    });
  });

  it("admits the closed hosted real runtime matrix with opt-in and hosted placement", () => {
    const cases = [
      {
        runtimeMode: "codex.exec_json",
        runtime: "codex",
        provider: "openai",
        adapterType: "process"
      },
      {
        runtimeMode: "claude_code.sdk",
        runtime: "claude_code",
        provider: "anthropic",
        adapterType: "native"
      },
      {
        runtimeMode: "opencode.acp",
        runtime: "opencode",
        provider: "opencode",
        adapterType: "acpx"
      }
    ] as const;

    for (const testCase of cases) {
      expect(normalizeDebateRuntime({
        role: "skeptic",
        model: "model",
        runtimeMode: testCase.runtimeMode,
        placement: "hosted",
        realRuntimeOptIn: true
      }, 1)).toMatchObject({
        runtime: testCase.runtime,
        provider: testCase.provider,
        model: "model",
        adapterType: testCase.adapterType,
        runtimeMode: testCase.runtimeMode,
        placement: "hosted",
        realRuntimeOptIn: true,
        isRealRuntime: true
      });
    }
  });

  it("requires real runtime opt-in before caller-owned side effects", () => {
    let sideEffects = 0;

    expect(() => {
      normalizeDebateRuntime({ runtimeMode: "codex.exec_json", placement: "hosted" }, 0);
      sideEffects += 1;
    }).toThrowError(DebateRuntimeMatrixError);

    expect(sideEffects).toBe(0);
    expect(() => normalizeDebateRuntime({ runtimeMode: "codex.exec_json", placement: "hosted" }, 0))
      .toThrowError(expect.objectContaining({ code: "debate_real_participant_opt_in_required" }));
  });

  it("requires hosted placement for real participants with opt-in", () => {
    for (const placement of [undefined, "local", "connected_local_node"] as const) {
      expect(() => normalizeDebateRuntime({
        runtimeMode: "opencode.acp",
        placement,
        realRuntimeOptIn: true
      }, 1)).toThrowError(expect.objectContaining({ code: "debate_participant_placement_required" }));
    }
  });

  it("fails closed for unsupported and unshipped debate runtimes", () => {
    const cases = [
      ["codex.interactive", "hosted_codex_interactive_unshipped"],
      ["agentfield.async_rest", "agentfield_bridge_unshipped"],
      ["generic_http.async_rest", "generic_http_bridge_unshipped"],
      ["browser.session", "browser_tool_unshipped"],
      ["repo.checkout", "repo_hosted_unshipped"],
      ["process.exec", "debate_runtime_unsupported"],
      ["terminal", "debate_runtime_unsupported"],
      ["shell", "debate_runtime_unsupported"],
      ["sandbox", "debate_runtime_unsupported"],
      ["pty", "debate_runtime_unsupported"],
      ["cursor", "debate_runtime_unsupported"]
    ] as const;

    for (const [runtimeMode, code] of cases) {
      expect(() => normalizeDebateRuntime({ runtimeMode, realRuntimeOptIn: true, placement: "hosted" }, 0))
        .toThrowError(expect.objectContaining({ code }));
    }
  });

  it("builds deterministic child run keys and participant metadata", () => {
    const input = {
      debateId: "debate_1",
      participantId: "participant_1",
      participantRole: "affirmative",
      debateRound: 2,
      debatePhase: "argument",
      debateRunKind: "participant" as const
    };
    const key = buildDebateChildRunKey(input);

    expect(key).toBe(buildDebateChildRunKey(input));
    expect(key).not.toBe(buildDebateChildRunKey({ ...input, debateRound: 3 }));
    expect(buildDebateChildRunMetadata(input)).toEqual({
      debateId: "debate_1",
      participantId: "participant_1",
      participantRole: "affirmative",
      debateRound: 2,
      debatePhase: "argument",
      debateRunKind: "participant",
      debateChildRunKey: key
    });
    expect(buildDebateChildRunKey({
      debateId: "debate_1",
      judgeId: "judge:model",
      debateRound: 2,
      debatePhase: "judge",
      debateRunKind: "judge"
    })).toContain("judge~3Amodel");
  });

  it("extracts only matching persisted runtime output under the byte cap", () => {
    const childRunKey = buildDebateChildRunKey({
      debateId: "debate_1",
      participantId: "participant_1",
      debateRound: 1,
      debatePhase: "argument",
      debateRunKind: "participant"
    });

    const result = extractDebateRuntimeOutput([
      event({ id: "event_status", type: "runtime.status", payload: { text: "ignore me" } }),
      event({
        id: "event_output_1",
        type: "runtime.output",
        debateId: "debate_1",
        payload: {
          text: "  participant answer  ",
          debateChildRunKey: childRunKey
        }
      })
    ], {
      debateId: "debate_1",
      childRunKey,
      maxBytes: 64,
      runId: "run_1"
    });

    expect(result).toEqual({
      ok: true,
      text: "participant answer",
      outputBytes: 22,
      eventId: "event_output_1",
      runId: "run_1",
      sequence: 1
    });
  });

  it("rejects missing, blank, overlarge, wrong-debate, and wrong-child output", () => {
    const childRunKey = "debate-child:debate_1:participant_1:1:argument:participant";
    const baseExpected = {
      debateId: "debate_1",
      childRunKey,
      maxBytes: 12,
      runId: "run_1"
    };

    expect(extractDebateRuntimeOutput([], baseExpected)).toMatchObject({
      ok: false,
      code: "debate_participant_output_missing"
    });
    expect(extractDebateRuntimeOutput([
      event({ type: "runtime.output", debateId: "debate_1", payload: { text: "   ", debateChildRunKey: childRunKey } })
    ], baseExpected)).toMatchObject({
      ok: false,
      code: "debate_participant_output_empty"
    });
    expect(extractDebateRuntimeOutput([
      event({ type: "runtime.output", debateId: "debate_1", payload: { text: "0123456789abc", debateChildRunKey: childRunKey } })
    ], baseExpected)).toMatchObject({
      ok: false,
      code: "debate_participant_output_too_large",
      outputBytes: 13
    });
    expect(extractDebateRuntimeOutput([
      event({ type: "runtime.output", debateId: "debate_other", payload: { text: "answer", debateChildRunKey: childRunKey } })
    ], baseExpected)).toMatchObject({
      ok: false,
      code: "debate_participant_output_unowned"
    });
    expect(extractDebateRuntimeOutput([
      event({ type: "runtime.output", debateId: "debate_1", payload: { text: "answer", debateChildRunKey: "wrong" } })
    ], baseExpected)).toMatchObject({
      ok: false,
      code: "debate_participant_output_unowned"
    });
  });

  it("classifies terminal debate output as late and non-routable", () => {
    expect(classifyDebateRuntimeOutputTiming({ debateStatus: "completed" })).toEqual({
      classification: "late",
      canRouteMessage: false,
      recommendedAction: "ignore_or_record_late"
    });
    expect(classifyDebateRuntimeOutputTiming({ debateStatus: "arguing" })).toEqual({
      classification: "current",
      canRouteMessage: true,
      recommendedAction: "route"
    });
  });
});

function event(overrides: Partial<SwitchyardEvent>): SwitchyardEvent {
  return {
    id: overrides.id ?? "event_1",
    type: overrides.type ?? "runtime.output",
    runId: overrides.runId ?? "run_1",
    debateId: overrides.debateId,
    sequence: overrides.sequence ?? 1,
    payload: overrides.payload ?? {},
    createdAt: overrides.createdAt ?? "2026-06-02T00:00:00.000Z"
  };
}
