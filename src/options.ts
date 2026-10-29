import * as os from "node:os"
import * as path from "node:path"

/** The opencode data directory (sits next to opencode.db); generated images go here by default, not into the project */
export function defaultImageDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const base = env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share")
  return path.join(base, "opencode", "opencode-pica")
}

/**
 * Resolve the image output directory:
 * - Unconfigured → global data directory, decoupled from project/session
 * - Relative path → resolved against the current project directory (e.g. ".opencode-picas" puts them back in the project)
 * - Absolute path → used as-is
 */
export function resolveOutDir(directory: string, outDir?: string) {
  if (!outDir) return defaultImageDir()
  return path.isAbsolute(outDir) ? outDir : path.join(directory, outDir)
}

/** Plugin configuration, passed as the second element of the `plugin` tuple in the opencode config */
export type PluginOptions = {
  /** OpenAI-compatible image API endpoint; falls back to PI_IMAGE_BASE_URL, then to the active opencode provider's baseURL */
  baseURL?: string
  /**
   * API key; defaults to PI_IMAGE_API_KEY. Optional: key-less local endpoints (Ollama, LM Studio)
   * are supported — no Authorization header is sent when unset.
   */
  apiKey?: string
  /** Image model name; falls back to the default model of the active opencode provider */
  model?: string
  /**
   * Image output directory. Defaults to the global data directory (keep the default to stay
   * decoupled from project/session); a relative path (e.g. ".opencode-picas") lands in the current project.
   */
  outDir?: string
  /** Max longest edge (px) of images saved to disk; larger images are scaled down uniformly */
  maxSize?: number
  /** Check npm for the latest version when the first image is generated; append an upgrade hint to the tool output when outdated. Default on */
  updateCheck?: boolean
  /** Inject one "which tool to use for images" rule into the system prompt. Default on */
  injectPrompt?: boolean
  /** Per-image-request timeout (ms) */
  timeoutMs?: number
}

export const DEFAULT_MAX_SIZE = 1024
export const DEFAULT_TIMEOUT_MS = 600_000

export type ResolvedOptions = {
  /** Optional until inherited from the active opencode provider; validated before the first API call */
  baseURL?: string
  /** Optional: omitted when talking to key-less local endpoints */
  apiKey?: string
  /** Optional until inherited from the active opencode provider; validated before the first API call */
  model?: string
  outDir?: string
  maxSize: number
  updateCheck: boolean
  injectPrompt: boolean
  timeoutMs: number
}

/**
 * Merge user options and environment variables. Nothing is thrown here: baseURL/model/API key
 * may all be absent because they can be inherited from the active opencode provider later —
 * the tool execute paths validate them and fail with an actionable message.
 */
export function resolveOptions(options: PluginOptions | undefined): ResolvedOptions {
  const opts = options ?? {}
  const apiKey = opts.apiKey ?? process.env.PI_IMAGE_API_KEY
  return {
    baseURL:
      opts.baseURL === undefined && process.env.PI_IMAGE_BASE_URL === undefined
        ? undefined
        : (opts.baseURL ?? process.env.PI_IMAGE_BASE_URL)!.replace(/\/+$/, ""),
    apiKey: apiKey?.trim() ? apiKey : undefined,
    model: opts.model?.trim() ? opts.model : undefined,
    outDir: opts.outDir,
    maxSize: opts.maxSize ?? DEFAULT_MAX_SIZE,
    updateCheck: opts.updateCheck ?? true,
    injectPrompt: opts.injectPrompt ?? true,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}
