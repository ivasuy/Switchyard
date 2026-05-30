import type { ToolPolicyInput, ToolPolicyPort } from "../ports/policy.js";

const SECRET_KEY_PATTERN = /(token|apikey|authorization|password|secret|credential|cookie|privatekey|accesskey|refreshtoken|idtoken)/i;

function isSecretKey(key: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) {
    return true;
  }
  return /(^session$|(^|[_-])session([_-]|$))/i.test(key);
}

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry)) as T;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (key === "runtimeApprovalToken") {
        out[key] = entry;
        continue;
      }
      if (isSecretKey(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactSecrets(entry);
      }
    }
    return out as T;
  }
  return value;
}

function asRisk(input: Record<string, unknown>): string {
  const rawRisk = input["risk"];
  if (typeof rawRisk === "string") {
    return rawRisk;
  }
  const requiresApproval = input["requiresApproval"];
  if (requiresApproval === true) {
    return "risky";
  }
  return "safe";
}

export class LocalPolicyGate implements ToolPolicyPort {
  async decideTool(input: ToolPolicyInput) {
    const risk = asRisk(input.input);
    const baseTrace = {
      type: input.type,
      risk,
      approvalPolicy: input.runApprovalPolicy ?? "default"
    };

    if (input.type !== "fake_echo") {
      return {
        decision: "deny" as const,
        reasonCode: "tool_policy_denied",
        policyTrace: [redactSecrets({ rule: "real_tools_not_shipped", ...baseTrace })]
      };
    }

    if (risk === "risky" || risk === "destructive") {
      if (input.runApprovalPolicy === "deny") {
        return {
          decision: "deny" as const,
          reasonCode: "tool_policy_denied",
          policyTrace: [redactSecrets({ rule: "approval_policy_deny", ...baseTrace })]
        };
      }
      return {
        decision: "approval_required" as const,
        reasonCode: "approval_required",
        policyTrace: [redactSecrets({ rule: "requires_manual_approval", ...baseTrace })]
      };
    }

    return {
      decision: "allow" as const,
      reasonCode: "allow",
      policyTrace: [redactSecrets({ rule: "safe_fake_echo", ...baseTrace })]
    };
  }
}
