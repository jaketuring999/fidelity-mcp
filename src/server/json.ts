const MAX_JSON_NESTING = 64;

export function parseJsonObject(text: string): Record<string, unknown> {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') {
      depth++;
      if (depth > MAX_JSON_NESTING) throw new SyntaxError('JSON nesting is too deep.');
    } else if (character === '}' || character === ']') depth--;
  }

  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new SyntaxError('Expected a JSON object.');
  return value as Record<string, unknown>;
}
