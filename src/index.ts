import { type Api } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER_ID = "axonhub";
const DEFAULT_BASE_URL = "http://localhost:8090";
const AXONHUB_CACHE_FILE = join(homedir(), ".cache", "pi", "axonhub-models.json");
const MODELS_DEV_CACHE_FILE = join(homedir(), ".cache", "pi", "models-dev-api.json");
const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL = 24 * 60 * 60 * 1000;

type PluginOptions = {
  baseUrl?: string;
  apiKey?: string;
  cacheTtl?: number;
};

type AxonHubModel = {
  id?: string;
  name?: string;
  display_name?: string;
  created?: number;
  created_at?: string;
  owned_by?: string;
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: {
    vision?: boolean;
    tool_call?: boolean;
    toolCall?: boolean;
    reasoning?: boolean;
  };
  pricing?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cacheRead?: number;
    cache_write?: number;
    cacheWrite?: number;
  };
};

type AxonHubModelsResponse = {
  data?: AxonHubModel[];
};

type ModelsDevReasoningOption =
  | { type: "toggle" }
  | { type: "effort"; values?: ("none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | null)[] }
  | { type: "budget_tokens"; min?: number; max?: number };

type ModelsDevModel = {
  id?: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  tool_call?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  family?: string;
  canonical_model_id?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
};

type ModelsDevProvider = {
  id?: string;
  models?: Record<string, ModelsDevModel>;
};

type ModelsDevResponse = Record<string, ModelsDevProvider>;

type ModelsDevMatch = {
  providerId: string;
  model: ModelsDevModel;
};

type AxonHubModelConfig = ProviderModelConfig;

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

function resolveOption(value: string | undefined) {
  if (!value) return;
  return process.env[value] || value;
}

function resolveBaseUrl(options?: PluginOptions) {
  return normalizeBaseUrl(options?.baseUrl ?? process.env.AXONHUB_BASE_URL ?? DEFAULT_BASE_URL);
}

function resolveApiKey(options?: PluginOptions) {
  return resolveOption(options?.apiKey) ?? process.env.AXONHUB_API_KEY;
}

async function readPiAuthApiKey() {
  try {
    const payload = JSON.parse(await readFile(join(getAgentDir(), "auth.json"), "utf8")) as Record<
      string,
      { type?: string; key?: string }
    >;
    const auth = payload[PROVIDER_ID];
    if (auth?.type === "api_key" && typeof auth.key === "string" && auth.key.length > 0) return auth.key;
  } catch {
    return;
  }
}


async function readFreshCache<T>(file: string, ttl: number) {
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > ttl) return;
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return;
  }
}

async function readCache<T>(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return;
  }
}

async function writeCache(file: string, payload: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(payload, null, 2));
}

async function fetchModels(baseUrl: string, key: string) {
  const headers = { Authorization: `Bearer ${key}` };
  const [basic, detailed] = await Promise.all([
    fetch(`${baseUrl}/v1/models`, { headers }),
    fetch(`${baseUrl}/v1/models?include=all`, { headers }),
  ]);

  const payloads: AxonHubModelsResponse[] = [];
  for (const response of [basic, detailed]) {
    if (!response.ok) continue;
    const payload = (await response.json()) as AxonHubModelsResponse;
    if (Array.isArray(payload.data)) payloads.push(payload);
  }
  if (payloads.length === 0) return { data: [] };

  const byId = new Map<string, AxonHubModel>();
  for (const payload of payloads) {
    for (const model of payload.data ?? []) {
      if (!model.id) continue;
      byId.set(model.id, { ...byId.get(model.id), ...model });
    }
  }
  return { data: [...byId.values()] };
}

async function loadModels(baseUrl: string, key: string, ttl: number) {
  const cached = await readFreshCache<AxonHubModelsResponse>(AXONHUB_CACHE_FILE, ttl);
  if (cached) return cached;

  const payload = await fetchModels(baseUrl, key);
  await writeCache(AXONHUB_CACHE_FILE, payload);
  return payload;
}

async function fetchModelsDev() {
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) throw new Error(`Failed to fetch ${MODELS_DEV_URL}: ${response.status} ${response.statusText}`);
  return (await response.json()) as ModelsDevResponse;
}

async function loadModelsDev(ttl: number) {
  const cached = await readFreshCache<ModelsDevResponse>(MODELS_DEV_CACHE_FILE, ttl);
  if (cached) return cached;

  try {
    const payload = await fetchModelsDev();
    await writeCache(MODELS_DEV_CACHE_FILE, payload);
    return payload;
  } catch {
    return (await readCache<ModelsDevResponse>(MODELS_DEV_CACHE_FILE)) ?? {};
  }
}

function modelsDevIndex(payload: ModelsDevResponse) {
  const index = new Map<string, ModelsDevMatch[]>();

  for (const [providerId, provider] of Object.entries(payload)) {
    for (const [key, model] of Object.entries(provider.models ?? {})) {
      const match = { providerId, model };
      for (const id of new Set([key, model.id].filter((value): value is string => typeof value === "string"))) {
        const matches = index.get(id);
        if (matches) matches.push(match);
        else index.set(id, [match]);
      }
    }
  }

  return index;
}

function modelsDevMatch(item: AxonHubModel, index: Map<string, ModelsDevMatch[]>) {
  if (!item.id) return;
  const matches = index.get(item.id);
  if (!matches?.length) return;

  const owner = item.owned_by;
  return (
    (owner ? matches.find((match) => match.providerId === owner) : undefined) ??
    matches.find((match) => match.providerId === "openai") ??
    matches.find((match) => match.providerId === "anthropic") ??
    matches[0]
  );
}

function hasModality(model: ModelsDevModel | undefined, direction: "input" | "output", modality: string) {
  return model?.modalities?.[direction]?.includes(modality);
}

const OWNER_BY_PROVIDER_ID: Record<string, "anthropic" | "gemini" | "openai"> = {
  anthropic: "anthropic",
  gemini: "gemini",
  google: "gemini",
  openai: "openai",
};

function normalizeOwner(owner?: string) {
  return owner ? OWNER_BY_PROVIDER_ID[owner] : undefined;
}

function ownerFromMatch(item: AxonHubModel, match?: ModelsDevMatch) {
  return normalizeOwner(item.owned_by) ?? normalizeOwner(match?.providerId);
}

function modelApi(id: string, owner?: string): Api {
  if (id.includes("gpt")) return "openai-responses";
  if (owner === "anthropic") return "anthropic-messages";
  if (owner === "gemini") return "google-generative-ai";
  return "openai-completions";
}

function modelBaseUrl(baseUrl: string, owner?: string) {
  if (owner === "anthropic") return `${baseUrl}/anthropic`;
  if (owner === "gemini") return `${baseUrl}/gemini/v1beta`;
  return `${baseUrl}/v1`;
}

function isAnthropicAdaptiveThinkingModel(id: string) {
  return (
    id.includes("opus-4-6") ||
    id.includes("opus-4.6") ||
    id.includes("opus-4-7") ||
    id.includes("opus-4.7") ||
    id.includes("sonnet-4-6") ||
    id.includes("sonnet-4.6")
  );
}

function effortValues(cached?: ModelsDevModel): string[] {
  const values: string[] = [];
  for (const option of cached?.reasoning_options ?? []) {
    if (option.type !== "effort") continue;
    for (const value of option.values ?? []) {
      if (typeof value === "string") values.push(value);
    }
  }
  return values;
}

/** Qwen/DashScope-compatible endpoints, which accept a full reasoning_effort ladder including "none". */
function isQwenModel(id: string, cached?: ModelsDevModel) {
  return (
    cached?.family === "qwen" ||
    cached?.id?.startsWith("qwen") ||
    cached?.canonical_model_id?.startsWith("alibaba/") ||
    id.startsWith("qwen")
  );
}

/**
 * Whether the endpoint takes an OpenAI-style `reasoning_effort`. models.dev is the source of truth
 * when it documents effort values; qwen is verified directly against AxonHub (none/minimal/low/
 * medium/high/xhigh/max all accepted, "default" rejected), and Axonhub normalizes the ladder for
 * models its catalog does not describe.
 */
function supportsReasoningEffort(id: string, reasoning: boolean, cached?: ModelsDevModel) {
  if (!reasoning) return false;
  if (effortValues(cached).length > 0) return true;
  // Documented thinking control without an effort ladder (toggle and/or budget only): trust it and
  // leave reasoning_effort out rather than risk a 400.
  if ((cached?.reasoning_options ?? []).length > 0) return false;
  // Undocumented model: qwen-compatible endpoints accept reasoning_effort (verified against AxonHub).
  return isQwenModel(id, cached);
}

/**
 * OpenAI-compatible backends behind AxonHub take `reasoning_effort`, but pi only sends it when
 * `supportsReasoningEffort` is true. With the previous hardcoded `false`, combined with
 * `thinkingFormat: "openai"` (which has no branch of its own and falls through to that same flag),
 * no thinking field was ever emitted and the selected thinking level had no effect on the request.
 */
function modelCompat(
  id: string,
  owner: string | undefined,
  reasoning: boolean,
  cached?: ModelsDevModel,
): ProviderModelConfig["compat"] | undefined {
  if (owner === "anthropic") {
    return isAnthropicAdaptiveThinkingModel(id) ? { forceAdaptiveThinking: true } : undefined;
  }
  if (owner === "gemini") return undefined;
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: supportsReasoningEffort(id, reasoning, cached),
    maxTokensField: "max_tokens" as const,
    thinkingFormat: "openai" as const,
  };
}

/**
 * Thinking level overrides. Only `off` and the extended levels (`xhigh`, `max`) are set: pi gates
 * `xhigh`/`max` behind an explicit mapping, and pi passes unmapped levels through unchanged, while a
 * `null` would drop the whole parameter. models.dev lists only part of the ladder (qwen reports
 * low/medium/xhigh), so nulling the rest would silently disable thinking control again.
 */
function modelThinkingLevelMap(
  id: string,
  reasoning: boolean,
  cached?: ModelsDevModel,
): Record<string, string | null> | undefined {
  if (!supportsReasoningEffort(id, reasoning, cached)) return;
  const values = effortValues(cached);
  const map: Record<string, string | null> = {};
  for (const level of ["xhigh", "max"] as const) {
    if (values.includes(level)) map[level] = level;
  }
  // Advertise "off" only where a no-thinking effort value is known to work, otherwise pi would send
  // reasoning_effort: "none" to servers that reject it.
  if (values.includes("none") || isQwenModel(id, cached)) map.off = "none";
  return Object.keys(map).length > 0 ? map : undefined;
}

function toProviderModel(baseUrl: string, item: AxonHubModel, match?: ModelsDevMatch): AxonHubModelConfig | undefined {
  if (!item.id) return;

  const cached = match?.model;
  const owner = ownerFromMatch(item, match);
  const reasoning = item.capabilities?.reasoning ?? cached?.reasoning ?? true;
  const supportsVision = item.capabilities?.vision ?? cached?.attachment ?? hasModality(cached, "input", "image") ?? true;

  return {
    id: item.id,
    name: item.name ?? item.display_name ?? cached?.name ?? item.id,
    api: modelApi(item.id, owner),
    reasoning,
    thinkingLevelMap: modelThinkingLevelMap(item.id, reasoning, cached),
    input: supportsVision ? ["text", "image"] : ["text"],
    cost: {
      input: item.pricing?.input ?? cached?.cost?.input ?? 0,
      output: item.pricing?.output ?? cached?.cost?.output ?? 0,
      cacheRead: item.pricing?.cache_read ?? item.pricing?.cacheRead ?? cached?.cost?.cache_read ?? 0,
      cacheWrite: item.pricing?.cache_write ?? item.pricing?.cacheWrite ?? cached?.cost?.cache_write ?? 0,
    },
    contextWindow: item.context_length ?? cached?.limit?.context ?? 200000,
    maxTokens: item.max_output_tokens ?? cached?.limit?.output ?? 32000,
    compat: modelCompat(item.id, owner, reasoning, cached),
    baseUrl: modelBaseUrl(baseUrl, owner),
  };
}

export default async function (pi: ExtensionAPI, options?: PluginOptions) {
  const baseUrl = resolveBaseUrl(options);
  const key = resolveApiKey(options) ?? (await readPiAuthApiKey());
  if (!key) return;

  const ttl = options?.cacheTtl ?? CACHE_TTL;
  const [payload, modelsDev] = await Promise.all([loadModels(baseUrl, key, ttl), loadModelsDev(ttl)]);
  const modelIndex = modelsDevIndex(modelsDev);
  const models = (payload.data ?? [])
    .map((item) => toProviderModel(baseUrl, item, modelsDevMatch(item, modelIndex)))
    .filter((model): model is AxonHubModelConfig => model !== undefined);

  pi.registerProvider(PROVIDER_ID, {
    baseUrl,
    apiKey: options?.apiKey ?? "$AXONHUB_API_KEY",
    models,
  });

  // Inject web_search tool for gpt-* models from axonhub
  // @ts-expect-error - ExtensionAPI.on exists at runtime via jiti, but ts can't resolve due to symlink
  pi.on("before_provider_request", (event: { payload: unknown }, ctx: { model?: { provider: string; id: string } }) => {
    const model = ctx.model;
    if (model?.provider !== PROVIDER_ID) return;
    if (!model.id.startsWith("gpt-")) return;

    const payload = event.payload as {
      tools?: Array<{ type: string; name?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };

    // Add web_search built-in tool
    const webSearchTool = { type: "web_search" as const };
    const existingTools = payload.tools ?? [];
    const hasWebSearch = existingTools.some((t) => t.type === "web_search");
    if (!hasWebSearch) {
      payload.tools = [...existingTools, webSearchTool];
    }

    return payload;
  });
}
