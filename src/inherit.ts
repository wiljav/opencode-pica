/**
 * Inherit the image provider configuration from the active opencode provider.
 *
 * There is no OpenAI-shaped default here on purpose: the plugin assumes nothing about the
 * user's provider. When the plugin options don't define baseURL/model, they are read from
 * opencode's runtime context (default model + provider record). Everything is wrapped in
 * try/catch so an older host, a missing domain, or an RPC failure degrades to "no
 * inheritance" instead of crashing the plugin.
 *
 * Verified against @opencode/plugin 2.0.27 and opencode v2.1.4:
 * - ctx.model.default() → Model.default() in opencode core, which returns the configured
 *   default model or the first available fallback — the app's DEFAULT model, not the model
 *   of the session requesting an image.
 * - Model IDs may embed their own vendor prefix (e.g. OpenRouter's "openai/gpt-image");
 *   providerID and modelID stay separate fields.
 * - ctx.provider.get(providerID) → { data: ProviderInfo } with an open-ended
 *   `settings` record; a user-configured baseURL lives there, not on a typed field.
 * - The provider's API key is deliberately NOT exposed by opencode, so apiKey is
 *   never inherited — players set PI_IMAGE_API_KEY / plugin apiKey, or use key-less
 *   local endpoints which simply send no Authorization header.
 */
export type InheritedConfig = { baseURL?: string; model?: string; providerID?: string }

type LooseRecord = Record<string, any> | undefined

function readBaseURL(settings: LooseRecord): string | undefined {
  if (!settings || typeof settings !== "object") return undefined
  const raw = settings.baseURL ?? settings.baseUrl ?? settings.url
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

/**
 * Full display identity for error messages: `provider/model` — unless the model ID already
 * embeds its own vendor prefix (OpenRouter-style "vendor/name", which would double it).
 */
export function describeModel(config: { providerID?: string; model?: string }): string {
  const model = config.model?.trim()
  if (!model) return "unknown"
  if (config.providerID?.trim() && !model.includes("/")) return `${config.providerID.trim()}/${model}`
  return model
}

export async function inheritProvider(ctx: any): Promise<InheritedConfig> {
  const out: InheritedConfig = {}
  try {
    const modelResult = await ctx?.model?.default?.()
    const modelInfo = modelResult?.data
    if (!modelInfo?.modelID) return out
    out.model = modelInfo.modelID
    const providerID = modelInfo.providerID
    if (providerID) {
      out.providerID = providerID
      const providerResult = await ctx?.provider?.get?.({ providerID })
      const provider = providerResult?.data
      const baseURL = readBaseURL(provider?.settings) ?? readBaseURL(modelInfo.settings)
      if (baseURL) out.baseURL = baseURL
    }
  } catch {
    // Inheritance is best-effort: any failure yields an empty result and the caller
    // throws an actionable configuration error instead.
  }
  return out
}
