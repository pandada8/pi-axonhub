# @pandada8/pi-axonhub

Pi extension that discovers AxonHub models from `/v1/models` and `/v1/models?include=all`, enriches them with cached metadata from `https://models.dev/api.json`, and registers them as the `axonhub` provider.

AxonHub models are cached at `~/.cache/pi/axonhub-models.json` for one day. `models.dev` metadata is cached at `~/.cache/pi/models-dev-api.json` for one day. If no API key is configured, the extension does not register the provider.

## Usage

Install the package into Pi's global settings:

```sh
pi install npm:@pandada8/pi-axonhub
```

This writes the package to `~/.pi/agent/settings.json` under `packages`. You can also edit it manually:

```json
{
  "packages": ["npm:@pandada8/pi-axonhub"]
}
```

Configure AxonHub and run Pi:

```sh
export AXONHUB_BASE_URL=http://localhost:8090
export AXONHUB_API_KEY=ah-your-api-key
pi
```

You can also store the key in `~/.pi/agent/auth.json`:

```json
{
  "axonhub": {
    "type": "api_key",
    "key": "ah-your-api-key"
  }
}
```

When using `auth.json`, `AXONHUB_API_KEY` is not required. `AXONHUB_BASE_URL` is optional and defaults to `http://localhost:8090`.

For local development, point Pi directly at this checkout:

```sh
pi -e /path/to/pi-axonhub
```

OpenAI-compatible models are sent to AxonHub `/v1`. Anthropic-owned models are sent to AxonHub `/anthropic`. Gemini-owned models are sent to AxonHub `/gemini`.

## Thinking levels

OpenAI-compatible models only receive a thinking control if pi is told the endpoint accepts one. The
extension sets `compat.supportsReasoningEffort` from `models.dev` `reasoning_options` effort values
(and, for undocumented Qwen/DashScope models, from the verified AxonHub behaviour), so the selected
thinking level is sent as `reasoning_effort` instead of being dropped. `reasoning_effort: "none"` is
used for thinking off on those models.

Levels other than `off`, `xhigh` and `max` are passed through untouched. Nulling the levels a
`models.dev` entry omits would make pi drop the whole parameter again (Qwen lists only
`low/medium/xhigh`, while AxonHub also accepts `none/minimal/high/max`).
