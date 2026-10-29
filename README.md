# opencode-pica

An image generation / editing plugin for [opencode](https://opencode.ai) that renders generated images **directly in the conversation** as inline Markdown images.

- `image_generate` — text-to-image
- `image_edit` — image-to-image (iterate on a previous result)
- No provider assumption: `baseURL`/`model` are inherited from the **active opencode provider** when not configured; plugin options always take precedence
- Output renders via a **downscaled inline JPEG data URI** (`data:image/jpeg;base64,...`) — compatible with opencode's web UI `Content-Security-Policy` (`img-src 'self' data: https: blob:`). The alt text is the fixed word "image" so no prompt characters can corrupt the markdown. Full-resolution PNG stays on disk for `image_edit` refinement
- Cross-platform scaling (based on [sharp](https://sharp.pixelplumbing.com)), no dependency on system commands such as `sips`

## How it works

1. The tool call goes to an OpenAI-compatible image endpoint:
   - Resolution order for `baseURL`/`model`: **plugin option → `PI_IMAGE_BASE_URL` env → the active opencode provider's configuration**
   - `apiKey` comes from the plugin option or `PI_IMAGE_API_KEY`; when unset, **no Authorization header is sent** (key-less local endpoints like Ollama/LM Studio work out of the box — opencode never exposes the provider's own key to plugins)
2. The returned bytes are normalized to PNG on disk in `outDir` (`maxSize` can scale down)
3. The tool output's first line is `![image](data:image/jpeg;base64,...)` — a downscaled JPEG (512px → 384px → 256px quality ladder) sized to stay under opencode's 50 KiB tool-output truncation budget. The data URI is compatible with opencode's web UI Content-Security-Policy (`img-src 'self' data: https: blob:`). Full resolution stays on disk at the path in the output; `image_edit` refines that file
4. The model is instructed to copy that line verbatim into the reply body
5. A `[Relay to user] Model/cost report: > **Model:** ... | **Cost:** $...` line is appended from the API's usage metadata (`usage.cost`, falling back to `usage.total_cost`)
6. If the active provider/model doesn't support image generation, the tool fails with an actionable message telling you exactly what to configure instead
7. A system-prompt rule and tool descriptions instruct the model to generate images **only when explicitly asked** — no unsolicited bonus/preview images

## Failures you may see

| Message | Meaning | Fix |
|---|---|---|
| `no image model is configured` | Neither plugin options, env, nor the active provider could provide `model`/`baseURL` | Set them in `opencode.jsonc` plugin options |
| `The currently active OpenCode provider/model (...) does not support image generation` | The inherited or configured model rejected the image request (404 on the image endpoint, non-image model, etc.). Errors show the full identity, e.g. `openrouter/gemini-2.5-flash-image`; OpenRouter-style model IDs already embed a vendor prefix and are shown verbatim | Configure a dedicated image-generation model, e.g. `"model": "google/gemini-2.5-flash-image-prestable"` |
| `returned 401 (authentication failed)` | The image endpoint requires a key and the plugin cannot inherit opencode's stored provider credentials (e.g. OpenRouter) — the request went out key-less | Set `apiKey` in the plugin options or `PI_IMAGE_API_KEY` in the environment |
| `returned 402 (insufficient credits)` / `returned 429 (rate limited)` | Account/rate-limit state at the provider | Top up or retry later; errors include the attempted endpoint and model |

## Options

The second element of the tuple in the `plugins` array is the plugin config:

| Field | Default | Description |
|---|---|---|
| `baseURL` | *inherited from the active opencode provider* | OpenAI-compatible image API endpoint. Plugin option > `PI_IMAGE_BASE_URL` env > provider inheritance |
| `model` | *inherited from the active opencode provider* | Image model name. Plugin option > provider inheritance |
| `apiKey` | `PI_IMAGE_API_KEY` | API key; optional for key-less local endpoints (no header sent when unset) |
| `outDir` | `<data dir>/opencode-pica` | Image output directory. Global by default, decoupled from project/session; a relative path (e.g. `.opencode-picas`) lands in the current project |
| `maxSize` | `1024` | Max longest edge of images saved to disk; larger images are scaled down uniformly |
| `updateCheck` | `true` | Check npm for a newer version when the first image is generated; append an upgrade hint to the tool output when outdated |
| `injectPrompt` | `true` | Inject one "which tool to use for images" rule into the system prompt |
| `timeoutMs` | `600000` | Per-request timeout |

### Ollama / LM Studio example

```jsonc
{
  "plugins": [
    ["opencode-pica", {
      // No apiKey, no baseURL: everything is inherited from the active provider
    }]
  ]
}
```

If the active default model can't generate images, configure a dedicated image model:

```jsonc
{
  "plugins": [
    ["opencode-pica", {
      "baseURL": "http://localhost:11434/v1",
      "model": "<provider>/<image-model>"
    }]
  ]
}
```

## Where images are stored

By default images land in **opencode's data directory** (`<XDG_DATA_HOME>/opencode/opencode-pica/`, i.e.
`~/.local/share/opencode/opencode-pica/` on macOS/Linux), next to `opencode.db`.

Why it's designed this way:

- **Not tied to project/session**: re-opening an old session from another directory, deleting a project, or moving a repo leaves historical images intact
- **Doesn't pollute the workspace**: no new entries in git changes
- Only when you actually want the images as project assets should you set `outDir` to a path inside the project (e.g. `".opencode-picas"`)

Relative `filename` arguments given to the tools are always resolved **strictly inside `outDir`**: a path trying to escape via `..` falls back to its bare name inside `outDir` (no path traversal). Absolute paths are honored as an explicit user decision.

## Install

opencode **2.0+** (v2 plugin API, `plugins` key — plural; the schema is `ConfigPlugin[]`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    ["opencode-pica@next", { "apiKey": "sk-..." }]
  ]
}
```

When opencode starts it automatically installs the plugin from npm into `~/.cache/opencode/npm/opencode-pica.../`.

### Local development

Point the `package` field at the **plugin repository root** (a directory, not the built file):

```jsonc
{
  "plugins": [
    "@xirothedev/openoffice-plugin-opencode",
    {
      "package": "/home/you/Downloads/test/opencode-pica",
      "options": {}
    }
  ]
}
```

Two loader rules observed in opencode 2.1.4 (`packages/core/src/config/plugin/source.ts` + `@opencode/plugin` `Host.resolve`):

1. **The target must be a directory.** A path pointing at a file (e.g. `.../dist/index.js`) is dropped with a log warning (`configured plugin path must be a directory`).
2. **The directory must contain a root-level entry file** (`index.js`, `index.ts`, `server.js`, or `server.ts`). The loader probes `<dir>/index` by filename and ignores the package.json `exports` map for local directories — this repo ships `index.ts` at its root for that reason, re-exporting `./dist/index.js`.

If the plugin still does not load, run `opencode` and check `~/.local/share/opencode/log/opencode.log` for `loading plugin` lines mentioning the directory.

## Upgrading

opencode **does not auto-upgrade** npm-based plugins. Its install logic reuses whatever is already
in the cache directory without comparing versions.

```sh
npx opencode-pica --update   # clear opencode's plugin cache
# Then restart opencode, which re-downloads the latest version
```

The plugin also checks npm once when it first generates an image; when it detects an older version it appends that command as a hint at the end of the tool output (disable with `updateCheck: false`).

## Environment variables

```bash
export PI_IMAGE_API_KEY=sk-...       # optional for key-less local providers
export PI_IMAGE_BASE_URL=https://api.example.com/v1   # optional; default = inherited from the active provider
```

## Platform support

Scaling uses `sharp` (a Node-API native module; npm installs the prebuilt package for your platform automatically).
macOS / Linux / Windows all work.

## Development

```bash
npm install
npm test        # End-to-end tests: stub the image API, then verify persistence, data-URI rendering, inheritance, and security boundaries
npm run build   # Produces dist/index.js + dist/index.d.ts
```

Note: The test suite uses `bun:test` for now. If you have bun installed, run `npm test` as above. A future release will standardize on `npm test` instead.

## Known limitations

- Image display uses an inline data URI so it works on any client (web UI, TUI, desktop). The downscaled JPEG stays under opencode's 50 KiB tool-output truncation limit.
- The inherited model is opencode's **default** model, not a per-session override; session-level model switches aren't visible to the plugin.
- The provider's auth key is never inherited (opencode hides it): for cloud providers set `apiKey`/`PI_IMAGE_API_KEY`; for local key-less endpoints nothing is needed.
- Some providers don't implement the OpenAI `/images/generations` / `/images/edits` shape at all; in that case the tool fails with the actionable "does not support image generation" message.

## License

Apache License 2.0