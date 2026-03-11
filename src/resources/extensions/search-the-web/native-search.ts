/**
 * Native Anthropic web search hook logic.
 *
 * Extracted from index.ts so it can be unit-tested without importing
 * the heavy tool-registration modules.
 */

/** Tool names for the Brave-backed custom search tools */
export const BRAVE_TOOL_NAMES = ["search-the-web", "search_and_read"];

/** Minimal interface matching the subset of ExtensionAPI we use */
export interface NativeSearchPI {
  on(event: string, handler: (...args: any[]) => any): void;
  getActiveTools(): string[];
  setActiveTools(tools: string[]): void;
}

/**
 * Register model_select, before_provider_request, and session_start hooks
 * for native Anthropic web search injection.
 *
 * Returns the isAnthropicProvider getter for testing.
 */
export function registerNativeSearchHooks(pi: NativeSearchPI): { getIsAnthropic: () => boolean } {
  let isAnthropicProvider = false;

  // Track provider changes via model selection
  pi.on("model_select", async (event: any, _ctx: any) => {
    const wasAnthropic = isAnthropicProvider;
    isAnthropicProvider = event.model.provider === "anthropic";

    const hasBrave = !!process.env.BRAVE_API_KEY;

    // When Anthropic + no Brave key: disable custom search tools (they'd fail)
    if (isAnthropicProvider && !hasBrave) {
      const active = pi.getActiveTools();
      pi.setActiveTools(
        active.filter((t: string) => !BRAVE_TOOL_NAMES.includes(t))
      );
    } else if (!isAnthropicProvider && wasAnthropic && !hasBrave) {
      // Switching away from Anthropic without Brave — re-enable so the user
      // sees the "missing key" error rather than tools silently vanishing
      const active = pi.getActiveTools();
      pi.setActiveTools([...active, ...BRAVE_TOOL_NAMES]);
    }
  });

  // Inject native web search into Anthropic API requests
  pi.on("before_provider_request", (event: any) => {
    const payload = event.payload as Record<string, unknown>;
    if (!payload) return;

    // Detect Anthropic by model name prefix (works even before model_select fires)
    const model = payload.model as string | undefined;
    if (!model || !model.startsWith("claude")) return;

    // Keep provider tracking in sync
    isAnthropicProvider = true;

    if (!Array.isArray(payload.tools)) payload.tools = [];

    // Don't double-inject if already present
    const tools = payload.tools as Array<Record<string, unknown>>;
    if (tools.some((t) => t.type === "web_search_20250305")) return;

    tools.push({
      type: "web_search_20250305",
      name: "web_search",
    });

    return payload;
  });

  // Startup diagnostics
  pi.on("session_start", async (_event: any, ctx: any) => {
    const hasBrave = !!process.env.BRAVE_API_KEY;
    const hasJina = !!process.env.JINA_API_KEY;
    const hasAnswers = !!process.env.BRAVE_ANSWERS_KEY;

    const parts: string[] = ["Web search v4 loaded"];

    if (isAnthropicProvider) parts.push("Native search ✓");
    if (hasBrave) parts.push("Brave ✓");
    if (hasAnswers) parts.push("Answers ✓");
    if (hasJina) parts.push("Jina ✓");

    if (!isAnthropicProvider && !hasBrave) {
      ctx.ui.notify(
        "Web search: Set BRAVE_API_KEY or use an Anthropic model for built-in search",
        "warning"
      );
    }

    ctx.ui.notify(parts.join(" · "), "info");
  });

  return { getIsAnthropic: () => isAnthropicProvider };
}
