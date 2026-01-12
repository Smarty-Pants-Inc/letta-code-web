import Letta from "@letta-ai/letta-client";

export async function validateAccessToken(baseURL: string, apiKey: string) {
  try {
    const client = new Letta({
      apiKey,
      baseURL,
      defaultHeaders: { "X-Letta-Source": "letta-code-web-tui" },
    });

    await client.agents.list({ limit: 1 });
    return { ok: true as const };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false as const, message };
  }
}
