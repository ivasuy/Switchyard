import { readFile } from "node:fs/promises";

export type ProductionEnvParseErrorCode =
  | "env_file_missing"
  | "env_file_empty"
  | "env_file_invalid_line"
  | "env_duplicate_key";

export interface ProductionEnvParseError {
  code: ProductionEnvParseErrorCode;
  line?: number;
  key?: string;
}

export type ProductionEnvParseResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; errors: ProductionEnvParseError[] };

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function parseProductionEnvFile(path: string): Promise<ProductionEnvParseResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return {
        ok: false,
        errors: [{ code: "env_file_missing" }]
      };
    }
    throw error;
  }

  if (text.trim().length === 0) {
    return {
      ok: false,
      errors: [{ code: "env_file_empty" }]
    };
  }

  const values: Record<string, string> = {};
  const errors: ProductionEnvParseError[] = [];
  const seenKeys = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index] ?? "";
    const leftTrimmed = line.trimStart();

    if (leftTrimmed.length === 0) {
      continue;
    }
    if (leftTrimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      errors.push({ code: "env_file_invalid_line", line: lineNo });
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      errors.push({ code: "env_file_invalid_line", line: lineNo });
      continue;
    }

    if (seenKeys.has(key)) {
      errors.push({ code: "env_duplicate_key", key, line: lineNo });
      continue;
    }

    const rawValue = line.slice(separatorIndex + 1);
    const parsedValue = parseEnvValue(rawValue);
    if (!parsedValue.ok) {
      errors.push({ code: "env_file_invalid_line", line: lineNo });
      continue;
    }

    seenKeys.add(key);
    values[key] = parsedValue.value;
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors
    };
  }

  return {
    ok: true,
    values
  };
}

function parseEnvValue(raw: string): { ok: true; value: string } | { ok: false } {
  let position = 0;
  while (position < raw.length && isWhitespace(raw[position]!)) {
    position += 1;
  }

  if (position >= raw.length) {
    return { ok: true, value: "" };
  }

  const first = raw[position]!;
  if (first === "'") {
    return parseSingleQuoted(raw, position + 1);
  }

  if (first === '"') {
    return parseDoubleQuoted(raw, position + 1);
  }

  return parseUnquoted(raw.slice(position));
}

function parseSingleQuoted(raw: string, start: number): { ok: true; value: string } | { ok: false } {
  const end = raw.indexOf("'", start);
  if (end < 0) {
    return { ok: false };
  }

  const literal = raw.slice(start, end);
  const tail = raw.slice(end + 1);
  if (!tailIsValid(tail)) {
    return { ok: false };
  }

  return { ok: true, value: literal.trim().length === 0 ? "" : literal };
}

function parseDoubleQuoted(raw: string, start: number): { ok: true; value: string } | { ok: false } {
  let position = start;
  let out = "";

  while (position < raw.length) {
    const char = raw[position]!;
    if (char === '"') {
      const tail = raw.slice(position + 1);
      if (!tailIsValid(tail)) {
        return { ok: false };
      }
      return { ok: true, value: out.trim().length === 0 ? "" : out };
    }

    if (char === "\\") {
      const next = raw[position + 1];
      if (next !== '"' && next !== "\\") {
        return { ok: false };
      }
      out += next;
      position += 2;
      continue;
    }

    out += char;
    position += 1;
  }

  return { ok: false };
}

function parseUnquoted(raw: string): { ok: true; value: string } | { ok: false } {
  let commentStart = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "#") {
      const previous = index > 0 ? raw[index - 1] : "";
      if (isWhitespace(previous)) {
        commentStart = index;
        break;
      }
    }
  }

  const withoutComment = (commentStart >= 0 ? raw.slice(0, commentStart) : raw).trim();
  return { ok: true, value: withoutComment.length === 0 ? "" : withoutComment };
}

function tailIsValid(tail: string): boolean {
  const trimmedStart = tail.trimStart();
  return trimmedStart.length === 0 || trimmedStart.startsWith("#");
}

function isWhitespace(value: string): boolean {
  return value === " " || value === "\t";
}
