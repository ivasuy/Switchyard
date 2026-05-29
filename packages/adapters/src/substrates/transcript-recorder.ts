export interface HttpTranscriptRequestEntry {
  method: string;
  path: string;
  status?: number;
  durationMs?: number;
  bytes?: number;
  maxBytes?: number;
  reasonCode?: string;
  message?: string;
}

export interface HttpTranscriptEventEntry {
  type: string;
  message?: string;
  status?: string;
  reasonCode?: string;
  cursor?: string;
}

export class TranscriptRecorder {
  private readonly lines: string[] = [];

  appendProcessStdout(line: string): void {
    if (line.length > 0) {
      this.lines.push(`${line}\n`);
    }
  }

  appendProcessStderr(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.lines.push(`${JSON.stringify({ type: "stderr", text })}\n`);
  }

  appendHttpRequest(entry: HttpTranscriptRequestEntry): void {
    this.lines.push(`${JSON.stringify({
      type: "http.request",
      method: entry.method,
      path: entry.path,
      status: entry.status,
      durationMs: entry.durationMs,
      bytes: entry.bytes,
      maxBytes: entry.maxBytes,
      reasonCode: entry.reasonCode,
      message: entry.message
    })}\n`);
  }

  appendHttpEvent(entry: HttpTranscriptEventEntry): void {
    this.lines.push(`${JSON.stringify({
      type: "http.event",
      eventType: entry.type,
      message: entry.message,
      status: entry.status,
      reasonCode: entry.reasonCode,
      cursor: entry.cursor
    })}\n`);
  }

  content(): string {
    return this.lines.join("");
  }

  metadata(input: { runtime: string; mode: string; runtimeMode?: string }): Record<string, unknown> {
    return {
      runtime: input.runtime,
      mode: input.mode,
      runtimeMode: input.runtimeMode,
      transcriptVersion: "r4.v1"
    };
  }
}
