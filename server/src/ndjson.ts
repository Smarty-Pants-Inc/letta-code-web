export function encodeNdjson(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function createNdjsonParser(
  onMessage: (message: unknown) => void,
): (chunk: string) => void {
  let buffer = "";

  return (chunk: string) => {
    buffer += chunk;

    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;

      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      try {
        onMessage(JSON.parse(line));
      } catch {
        // Ignore malformed lines.
      }
    }
  };
}
