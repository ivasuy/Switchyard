function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64Url(input: string): string {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64").toString("utf8");
}

export function encodeCursor(payload: Record<string, string>): string {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeCursor<TFields extends readonly string[]>(
  cursor: string,
  fields: TFields
): Record<TFields[number], string> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(fromBase64Url(cursor));
  } catch {
    throw new Error("malformed cursor");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("malformed cursor");
  }
  const record = decoded as Record<string, unknown>;
  const out = {} as Record<TFields[number], string>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("malformed cursor");
    }
    (out as Record<string, string>)[field] = value;
  }
  return out;
}
