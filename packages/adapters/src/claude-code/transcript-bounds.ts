const MAX_NORMALIZED_RECORD_BYTES = 64 * 1024;

export function finalizeTranscript(lines: string[], maxBytes: number): string {
  let bytes = 0;
  const kept: string[] = [];
  let omittedBytes = 0;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + lineBytes <= maxBytes) {
      kept.push(line);
      bytes += lineBytes;
      continue;
    }
    omittedBytes += lineBytes;
  }

  if (omittedBytes === 0) {
    return kept.join("");
  }

  const marker = `${JSON.stringify({ type: "transcript.truncated", maxBytes, omittedBytes, redacted: true })}\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");

  while (kept.length > 0 && bytes + markerBytes > maxBytes) {
    const popped = kept.pop()!;
    const poppedBytes = Buffer.byteLength(popped, "utf8");
    bytes -= poppedBytes;
    omittedBytes += poppedBytes;
  }

  const stableMarker = `${JSON.stringify({ type: "transcript.truncated", maxBytes, omittedBytes, redacted: true })}\n`;
  return `${kept.join("")}${stableMarker}`;
}

export function serializeNormalizedRecord(record: Record<string, unknown>): string {
  const serialized = JSON.stringify(record);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_NORMALIZED_RECORD_BYTES) {
    return serialized;
  }
  return JSON.stringify({
    type: "transcript.record_truncated",
    eventType: typeof record["type"] === "string" ? record["type"] : "unknown",
    originalBytes: bytes,
    redacted: true
  });
}
