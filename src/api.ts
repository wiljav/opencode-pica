export type RemoteImage = { url?: string; b64?: string; usage?: unknown }

/**
 * A non-OK response from the image provider. Carries the HTTP status and body so callers
 * can distinguish auth/credit/rate-limit failures from an unsupported-model response.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message)
    this.name = "ProviderHttpError"
  }
}


/** Extract the first image from a JSON or SSE (data: lines) response */
export function parseImageResponse(body: string): RemoteImage {
  const trimmed = body.trim()

  if (trimmed.startsWith("{")) {
    return fromPayload(JSON.parse(trimmed))
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw.startsWith("data:")) continue
    const payload = raw.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      return fromPayload(JSON.parse(payload))
    } catch {
      continue
    }
  }

  throw new Error(`opencode-pica: no image in response: ${trimmed.slice(0, 500)}`)
}

function fromPayload(obj: any): RemoteImage {
  const item = obj?.data?.[0] ?? obj
  if (item?.b64_json) return { b64: item.b64_json, usage: obj?.usage ?? item?.usage }
  if (typeof item?.url === "string") return { url: item.url, usage: obj?.usage ?? item?.usage }
  throw new Error(`opencode-pica: no image in response payload: ${JSON.stringify(obj).slice(0, 500)}`)
}

/** Merge an external AbortSignal with a timeout into a single disposable signal */
export function withTimeout(external: AbortSignal, ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms)
  const forward = () => controller.abort(external.reason)
  if (external.aborted) forward()
  else external.addEventListener("abort", forward, { once: true })
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      external.removeEventListener("abort", forward)
    },
  }
}

type RequestConfig = { baseURL: string; apiKey?: string; model: string; timeoutMs: number }

/** Human-readable mapping for common API error statuses */
const STATUS_HINTS: Record<number, string> = {
  401: "authentication failed (check apiKey)",
  402: "insufficient credits on this provider",
  404: "endpoint or model not found on this provider (the model likely does not support image generation)",
  429: "rate limited by this provider",
}

/**
 * Validate a URL before any network access, guarding against SSRF via user/API-supplied
 * locations: only http(s) is allowed, never file:, ftp:, data:, or other schemes.
 */
export function assertHttpUrl(raw: string, what: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`opencode-pica: invalid ${what}: ${JSON.stringify(raw.slice(0, 200))}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`opencode-pica: refusing to fetch non-http(s) ${what}: ${url.protocol}`)
  }
  return url
}

async function readImage(res: Response, endpoint: string): Promise<RemoteImage> {
  const body = await res.text()
  if (!res.ok) {
    const hint = STATUS_HINTS[res.status] ?? "provider request failed"
    throw new ProviderHttpError(
      res.status,
      body,
      `Image request failed: ${endpoint} returned ${res.status} (${hint}). ${body.slice(0, 500)}`,
    )
  }
  return parseImageResponse(body)
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  // Omit Authorization entirely for key-less local endpoints (Ollama, LM Studio).
  if (!apiKey) return { "Content-Type": "application/json" }
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
}

/** Download an image URL or base64 content as bytes (URL is SSRF-checked first) */
export async function fetchImageBytes(
  image: RemoteImage,
  signal: AbortSignal,
): Promise<Buffer> {
  if (image.b64) return Buffer.from(image.b64, "base64")
  if (!image.url) throw new Error("opencode-pica: response has neither url nor b64_json")
  assertHttpUrl(image.url, "image URL from the API response")
  let res: Response
  try {
    res = await fetch(image.url, { signal })
  } catch (error) {
    // Never echo raw fetch internals that could embed configured URLs/keys.
    throw new Error(`Image request failed while downloading the generated image URL: ${String(error)}`)
  }
  if (!res.ok) {
    const hint = STATUS_HINTS[res.status] ?? "download failed"
    throw new ProviderHttpError(
      res.status,
      "",
      `Image request failed: image URL download returned ${res.status} (${hint}).`,
    )
  }
  return Buffer.from(await res.arrayBuffer())
}

export async function generateImage(
  config: RequestConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<RemoteImage> {
  const url = assertHttpUrl(config.baseURL, "baseURL")
  let res: Response
  try {
    res = await fetch(`${url.origin}${url.pathname}/images/generations`, {
      method: "POST",
      headers: authHeaders(config.apiKey),
      body: JSON.stringify({ model: config.model, prompt, n: 1 }),
      signal,
    })
  } catch (error) {
    throw new Error(`Image request failed: POST /images/generations could not be reached (${String(error)}).`)
  }
  return readImage(res, "POST /images/generations")
}

export async function editImage(
  config: RequestConfig,
  source: Buffer,
  filename: string,
  prompt: string,
  signal: AbortSignal,
): Promise<RemoteImage> {
  const url = assertHttpUrl(config.baseURL, "baseURL")
  const form = new FormData()
  form.append("model", config.model)
  form.append("prompt", prompt)
  form.append("image", new Blob([new Uint8Array(source)], { type: "image/png" }), filename)
  let res: Response
  try {
    res = await fetch(`${url.origin}${url.pathname}/images/edits`, {
      method: "POST",
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      body: form,
      signal,
    })
  } catch (error) {
    throw new Error(`Image request failed: POST /images/edits could not be reached (${String(error)}).`)
  }
  return readImage(res, "POST /images/edits")
}
