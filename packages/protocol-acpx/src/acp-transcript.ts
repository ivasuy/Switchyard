import type { JsonRpcMessage } from "./json-rpc.js";

export type AcpTranscriptDirection = "in" | "out";

export interface AcpTranscriptMetadataInput {
  runtime: string;
  mode: string;
  runtimeMode?: string;
  acpSessionId?: string;
}

interface RedactionResult {
  text: string;
  redacted: boolean;
}

export class AcpTranscriptRecorder {
  private readonly lines: string[] = [];

  appendMessage(
    direction: AcpTranscriptDirection,
    rawLine: string,
    parsed?: JsonRpcMessage
  ): void {
    const redaction = redactSecrets(rawLine);
    const entry: Record<string, unknown> = {
      type: "acp.message",
      direction,
      timestamp: new Date().toISOString(),
      byteLength: Buffer.byteLength(rawLine, "utf8"),
      raw: redaction.text
    };
    if (redaction.redacted) {
      entry["redacted"] = true;
    }
    if (parsed && typeof parsed === "object") {
      if ("jsonrpc" in parsed) {
        entry["jsonrpc"] = parsed.jsonrpc;
      }
      if ("id" in parsed && (typeof parsed.id === "number" || typeof parsed.id === "string")) {
        entry["id"] = parsed.id;
      }
      if ("method" in parsed && typeof parsed.method === "string") {
        entry["method"] = parsed.method;
      }
    }
    this.lines.push(`${JSON.stringify(entry)}\n`);
  }

  appendStderr(text: string): void {
    if (text.length === 0) {
      return;
    }
    const redaction = redactSecrets(text);
    this.lines.push(`${JSON.stringify({
      type: "acp.stderr",
      timestamp: new Date().toISOString(),
      byteLength: Buffer.byteLength(text, "utf8"),
      text: redaction.text,
      ...(redaction.redacted ? { redacted: true } : {})
    })}\n`);
  }

  appendOversized(direction: AcpTranscriptDirection, byteLength: number): void {
    this.lines.push(`${JSON.stringify({
      type: "acp.oversized",
      direction,
      timestamp: new Date().toISOString(),
      byteLength,
      reasonCode: "acp_message_too_large"
    })}\n`);
  }

  content(): string {
    return this.lines.join("");
  }

  metadata(input: AcpTranscriptMetadataInput): Record<string, unknown> {
    return {
      runtime: input.runtime,
      mode: input.mode,
      runtimeMode: input.runtimeMode,
      protocol: "acp",
      transport: "stdio",
      transcriptVersion: "r5.acp.v1",
      ...(input.acpSessionId ? { acpSessionId: input.acpSessionId } : {})
    };
  }
}

function redactSecrets(input: string): RedactionResult {
  let output = input;

  output = output.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
  output = output.replace(/("Authorization"\s*:\s*")[^"]*"/gi, "$1[REDACTED]\"");
  output = output.replace(/(authorization\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  output = output.replace(/([A-Za-z0-9_]*(?:_TOKEN|_KEY|_SECRET)"\s*:\s*")[^"]*"/gi, "$1[REDACTED]\"");
  output = output.replace(/([A-Za-z0-9_]*(?:_TOKEN|_KEY|_SECRET)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  output = output.replace(/\/([^/\s"]*(?:token|secret|key)[^/\s"]*)/gi, "/[REDACTED_SEGMENT]");

  return {
    text: output,
    redacted: output !== input
  };
}
