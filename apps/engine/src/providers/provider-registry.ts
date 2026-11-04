import type { ModelRequestObserver } from "../domain/model-usage.js";
import { EngineStartupError, type EnvironmentRecord } from "../env.js";
import type { ModelProvider } from "./model-provider.js";
import {
  OPENAI_COMPATIBLE_KIND,
  OpenAICompatibleProvider,
  type OpenAICompatibleAdapterOptions,
} from "./openai-compatible-adapter.js";
import { OPENROUTER_BASE_URL } from "./openrouter-adapter.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { PROVIDER_PRESETS } from "./provider-presets.js";

/**
 * Parses the `AI_*` environment into named provider profiles and per-role
 * bindings. Every inconsistency fails closed with an `EngineStartupError`
 * that names the offending variable and never echoes a configured value.
 *
 * ```
 * AI_PROVIDERS=go,or
 * AI_PROVIDER_GO_PRESET=opencode-go
 * AI_PROVIDER_GO_API_KEY=...
 * AI_PROVIDER_OR_KIND=openrouter
 * AI_PROVIDER_OR_API_KEY=...
 * AI_EMBEDDING=or:google/gemini-embedding-001
 * AI_ANSWER=go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash
 * ```
 */

export const REGISTRY_EMBEDDING_DIMENSIONS = 1_536;
const DEFAULT_EMBEDDING_REVISION = "provider-managed";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROFILES = 16;
const MAX_FAILOVER_ENTRIES = 5;
/** Matches the `proposalProvider` and `proposalModel` storage limits. */
const MAX_INGESTION_IDENTITY = 200;

export const providerKinds = ["openrouter", "openai-compatible"] as const;
export type ProviderProfileKind = (typeof providerKinds)[number];

export const providerPrivacyLevels = ["enforced", "attested", "none"] as const;
export type ProviderPrivacy = (typeof providerPrivacyLevels)[number];

export const registryPresetNames = ["opencode-go", "openai", "ollama", "openrouter"] as const;
export type RegistryPresetName = (typeof registryPresetNames)[number];

const structuredOutputModes = ["json_schema", "json_object", "prompt"] as const;

export const chatRoles = ["answer", "ingestion", "dreaming", "verification"] as const;
export type ChatRole = (typeof chatRoles)[number];
export type ProviderRole = "embedding" | ChatRole;

/** Fixed role and policy variable names. */
export const providerRegistryVariables = {
  providers: "AI_PROVIDERS",
  embedding: "AI_EMBEDDING",
  embeddingRevision: "AI_EMBEDDING_REVISION",
  embeddingDimensions: "AI_EMBEDDING_DIMENSIONS",
  answer: "AI_ANSWER",
  ingestion: "AI_INGESTION",
  dreaming: "AI_DREAMING",
  verification: "AI_VERIFICATION",
  requireZdr: "AI_REQUIRE_ZDR",
} as const;

/** Per-profile variable suffixes: `AI_PROVIDER_<NAME>_<SUFFIX>`. */
export const providerProfileSuffixes = [
  "KIND",
  "PRESET",
  "BASE_URL",
  "API_KEY",
  "PRIVACY",
  "STRUCTURED",
  "EXTRA_HEADERS",
  "USER_AGENT",
  "SESSION_HEADER",
  "MIN_COMPLETION_TOKENS",
  "SEND_DIMENSIONS",
  "REQUEST_TIMEOUT_MS",
] as const;
export type ProviderProfileSuffix = (typeof providerProfileSuffixes)[number];

export const PROVIDER_PROFILE_PREFIX = "AI_PROVIDER_";
const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;
/** Settings the OpenRouter adapter does not support; setting them fails closed. */
const OPENAI_COMPATIBLE_ONLY: readonly ProviderProfileSuffix[] = [
  "EXTRA_HEADERS",
  "USER_AGENT",
  "SESSION_HEADER",
  "MIN_COMPLETION_TOKENS",
  "SEND_DIMENSIONS",
];

export interface ProviderProfile {
  /** Lowercase profile name used in role bindings. */
  readonly name: string;
  /** Variable prefix, for example `AI_PROVIDER_GO`. */
  readonly variablePrefix: string;
  readonly kind: ProviderProfileKind;
  readonly preset: RegistryPresetName | undefined;
  readonly privacy: ProviderPrivacy;
  readonly requestTimeoutMs: number;
  readonly apiKey: string | undefined;
  /** True only for presets of local servers that need no credential. */
  readonly allowUnauthenticated: boolean;
  /** OpenRouter profiles: base URL. OpenAI-compatible profiles: full adapter options without the key. */
  readonly adapter:
    | { readonly kind: "openrouter"; readonly baseUrl: string }
    | { readonly kind: "openai-compatible"; readonly options: Omit<OpenAICompatibleAdapterOptions, "apiKey"> };
}

export interface RoleEntry {
  readonly profile: string;
  readonly model: string;
}

export interface ProviderRegistryConfiguration {
  readonly profiles: ReadonlyMap<string, ProviderProfile>;
  readonly embedding: RoleEntry & {
    readonly modelRevision: string;
    readonly dimensions: number;
  };
  /** Ordered failover lists; the first entry is the primary. */
  readonly chat: Readonly<Record<ChatRole, readonly RoleEntry[]>>;
  readonly requireZdr: boolean;
}

function fail(message: string): never {
  throw new EngineStartupError(message);
}

/** Unset or empty values count as absent, matching `requireEnvironment`. */
function read(environment: EnvironmentRecord, name: string): string | undefined {
  const value = environment[name];
  if (value === undefined || value === "") return undefined;
  if (value.trim() === "") fail(`${name} must not be blank.`);
  if (/[\r\n\0]/u.test(value)) fail(`${name} must be a single line.`);
  return value.trim();
}

function oneOf<T extends string>(
  environment: EnvironmentRecord,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = read(environment, name);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function integer(
  environment: EnvironmentRecord,
  name: string,
  minimum: number,
): number | undefined {
  const value = read(environment, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(minimum > 0 ? `${name} must be a positive integer.` : `${name} must be a non-negative integer.`);
  }
  return parsed;
}

function boolean(environment: EnvironmentRecord, name: string): boolean | undefined {
  const value = oneOf(environment, name, ["true", "false"] as const);
  return value === undefined ? undefined : value === "true";
}

function stringRecord(environment: EnvironmentRecord, name: string): Record<string, string> | undefined {
  const value = read(environment, name);
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(`${name} must be a JSON object of header names to string values.`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((item) => typeof item !== "string")
  ) {
    fail(`${name} must be a JSON object of header names to string values.`);
  }
  return parsed as Record<string, string>;
}

function list(environment: EnvironmentRecord, name: string): readonly string[] | undefined {
  const value = read(environment, name);
  if (value === undefined) return undefined;
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item === "")) fail(`${name} must not contain empty list entries.`);
  return items;
}

/** The `AI_REQUIRE_ZDR` policy flag; it is valid with or without `AI_PROVIDERS`. */
export function readRequireZdr(environment: EnvironmentRecord): boolean {
  return boolean(environment, providerRegistryVariables.requireZdr) ?? false;
}

/**
 * The provider-registry variables that are set, excluding the `AI_REQUIRE_ZDR`
 * policy flag. Any of them selects the registry; none keeps the legacy
 * `OPENROUTER_*` composition.
 */
export function providerRegistryVariablesInUse(environment: EnvironmentRecord): readonly string[] {
  const fixed = Object.values(providerRegistryVariables).filter(
    (name) => name !== providerRegistryVariables.requireZdr,
  );
  return Object.keys(environment)
    .filter((name) => (fixed as readonly string[]).includes(name) || name.startsWith(PROVIDER_PROFILE_PREFIX))
    .filter((name) => environment[name] !== undefined && environment[name] !== "")
    .sort();
}

export function usesProviderRegistry(environment: EnvironmentRecord): boolean {
  return providerRegistryVariablesInUse(environment).length > 0;
}

function profileVariable(prefix: string, suffix: ProviderProfileSuffix): string {
  return `${prefix}_${suffix}`;
}

function parseProfile(environment: EnvironmentRecord, name: string): ProviderProfile {
  const variablePrefix = `${PROVIDER_PROFILE_PREFIX}${name.toUpperCase()}`;
  const v = (suffix: ProviderProfileSuffix) => profileVariable(variablePrefix, suffix);

  const preset = oneOf(environment, v("PRESET"), registryPresetNames);
  const declaredKind = oneOf(environment, v("KIND"), providerKinds);
  const presetKind: ProviderProfileKind | undefined =
    preset === undefined ? undefined : preset === "openrouter" ? "openrouter" : "openai-compatible";
  if (declaredKind === undefined && presetKind === undefined) {
    fail(`${v("KIND")} or ${v("PRESET")} is required for profile "${name}".`);
  }
  if (declaredKind !== undefined && presetKind !== undefined && declaredKind !== presetKind) {
    fail(`${v("KIND")} must be ${presetKind} for ${v("PRESET")}=${preset}.`);
  }
  const kind = (declaredKind ?? presetKind)!;
  const baseUrl = read(environment, v("BASE_URL"));
  const apiKey = read(environment, v("API_KEY"));
  const requestTimeoutMs = integer(environment, v("REQUEST_TIMEOUT_MS"), 1) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const structured = oneOf(environment, v("STRUCTURED"), structuredOutputModes);
  const declaredPrivacy = oneOf(environment, v("PRIVACY"), providerPrivacyLevels);

  if (kind === "openrouter") {
    for (const suffix of OPENAI_COMPATIBLE_ONLY) {
      if (read(environment, v(suffix)) !== undefined) {
        fail(`${v(suffix)} is not supported by ${v("KIND")}=openrouter.`);
      }
    }
    if (structured !== undefined && structured !== "json_schema") {
      fail(`${v("STRUCTURED")} must be json_schema for ${v("KIND")}=openrouter.`);
    }
    return {
      name,
      variablePrefix,
      kind,
      preset,
      privacy: declaredPrivacy ?? "enforced",
      requestTimeoutMs,
      apiKey,
      allowUnauthenticated: false,
      adapter: { kind: "openrouter", baseUrl: baseUrl ?? OPENROUTER_BASE_URL },
    };
  }

  if (declaredPrivacy === "enforced") {
    fail(`${v("PRIVACY")}=enforced requires ${v("KIND")}=openrouter; other providers can only attest their privacy.`);
  }
  const presetDefinition = preset === undefined || preset === "openrouter" ? undefined : PROVIDER_PRESETS[preset];
  const resolvedBaseUrl = baseUrl ?? presetDefinition?.options.baseUrl;
  if (resolvedBaseUrl === undefined) {
    fail(`${v("BASE_URL")} is required for profile "${name}" without ${v("PRESET")}.`);
  }
  const extraHeaders = stringRecord(environment, v("EXTRA_HEADERS"));
  const userAgent = read(environment, v("USER_AGENT"));
  const sessionHeader = read(environment, v("SESSION_HEADER"));
  const minCompletionTokens = integer(environment, v("MIN_COMPLETION_TOKENS"), 0);
  const sendDimensions = boolean(environment, v("SEND_DIMENSIONS"));
  const options: Omit<OpenAICompatibleAdapterOptions, "apiKey"> = {
    ...presetDefinition?.options,
    kind: presetDefinition?.options.kind ?? OPENAI_COMPATIBLE_KIND,
    displayName: presetDefinition?.options.displayName ?? `OpenAI-compatible provider "${name}"`,
    baseUrl: resolvedBaseUrl,
    ...(structured === undefined ? {} : { structuredOutput: structured }),
    ...(extraHeaders === undefined ? {} : { extraHeaders }),
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(sessionHeader === undefined ? {} : { sessionHeader }),
    ...(minCompletionTokens === undefined ? {} : { minCompletionTokens }),
    ...(sendDimensions === undefined ? {} : { sendDimensions }),
  };
  return {
    name,
    variablePrefix,
    kind,
    preset,
    privacy: declaredPrivacy ?? presetDefinition?.privacy ?? "none",
    requestTimeoutMs,
    apiKey,
    allowUnauthenticated: options.allowUnauthenticated ?? false,
    adapter: { kind: "openai-compatible", options },
  };
}

function parseEntries(
  environment: EnvironmentRecord,
  variable: string,
  profiles: ReadonlyMap<string, ProviderProfile>,
): readonly RoleEntry[] | undefined {
  const items = list(environment, variable);
  if (items === undefined) return undefined;
  if (items.length > MAX_FAILOVER_ENTRIES) {
    fail(`${variable} accepts at most ${MAX_FAILOVER_ENTRIES} entries.`);
  }
  const seen = new Set<string>();
  return items.map((item, index) => {
    const separator = item.indexOf(":");
    const profile = separator < 0 ? "" : item.slice(0, separator).trim().toLowerCase();
    const model = separator < 0 ? "" : item.slice(separator + 1).trim();
    if (profile === "" || model === "") {
      fail(`${variable} entry ${index + 1} must have the form <profile>:<model>.`);
    }
    if (!profiles.has(profile)) {
      fail(`${variable} entry ${index + 1} names profile "${profile}", which ${providerRegistryVariables.providers} does not list.`);
    }
    const key = `${profile}:${model}`;
    if (seen.has(key)) fail(`${variable} entry ${index + 1} repeats an earlier entry.`);
    seen.add(key);
    return { profile, model };
  });
}

export interface ParseProviderRegistryOptions {
  /** Validated runtimes require a key for every bound profile; the lenient composition defers it to the first call. */
  readonly requireCredentials: boolean;
}

export function parseProviderRegistry(
  environment: EnvironmentRecord,
  options: ParseProviderRegistryOptions,
): ProviderRegistryConfiguration {
  const names = providerRegistryVariables;
  const declared = list(environment, names.providers);
  if (declared === undefined) {
    const inUse = providerRegistryVariablesInUse(environment);
    fail(`${names.providers} is required when provider registry variables are set (${inUse.join(", ")}).`);
  }
  if (declared.length > MAX_PROFILES) fail(`${names.providers} accepts at most ${MAX_PROFILES} profiles.`);
  const profiles = new Map<string, ProviderProfile>();
  for (const raw of declared) {
    if (!PROFILE_NAME.test(raw)) {
      fail(`${names.providers} profile names must start with a letter and contain only letters and digits (at most 32).`);
    }
    const name = raw.toLowerCase();
    if (profiles.has(name)) fail(`${names.providers} lists profile "${name}" more than once.`);
    profiles.set(name, parseProfile(environment, name));
  }

  // Profile variables for an unlisted profile or with an unknown suffix are typos; never ignore them.
  const prefixes = [...profiles.values()].map((profile) => `${profile.variablePrefix}_`);
  for (const variable of providerRegistryVariablesInUse(environment)) {
    if (!variable.startsWith(PROVIDER_PROFILE_PREFIX)) continue;
    const prefix = prefixes.find((candidate) => variable.startsWith(candidate));
    if (prefix === undefined) {
      fail(`${variable} does not belong to a profile listed in ${names.providers}.`);
    }
    if (!(providerProfileSuffixes as readonly string[]).includes(variable.slice(prefix.length))) {
      fail(`${variable} is not a recognized provider profile setting.`);
    }
  }

  const embeddingEntries = parseEntries(environment, names.embedding, profiles);
  if (embeddingEntries === undefined) fail(`${names.embedding} is required as <profile>:<model>.`);
  if (embeddingEntries.length !== 1) {
    fail(`${names.embedding} accepts exactly one <profile>:<model> entry; embeddings never fail over because vectors from different models must not mix.`);
  }
  const dimensions = integer(environment, names.embeddingDimensions, 1) ?? REGISTRY_EMBEDDING_DIMENSIONS;
  if (dimensions !== REGISTRY_EMBEDDING_DIMENSIONS) {
    fail(`${names.embeddingDimensions} must be ${REGISTRY_EMBEDDING_DIMENSIONS} because the vector columns are vector(${REGISTRY_EMBEDDING_DIMENSIONS}).`);
  }
  const embedding = {
    ...embeddingEntries[0]!,
    modelRevision: read(environment, names.embeddingRevision) ?? DEFAULT_EMBEDDING_REVISION,
    dimensions,
  };

  const answer = parseEntries(environment, names.answer, profiles);
  if (answer === undefined) fail(`${names.answer} is required as <profile>:<model>[,<profile>:<model>...].`);
  const chat: Record<ChatRole, readonly RoleEntry[]> = {
    answer,
    ingestion: parseEntries(environment, names.ingestion, profiles) ?? answer,
    dreaming: parseEntries(environment, names.dreaming, profiles) ?? answer,
    verification: parseEntries(environment, names.verification, profiles) ?? answer,
  };

  const ingestion = ingestionIdentity(chat.ingestion, profiles);
  if (ingestion.provider.length > MAX_INGESTION_IDENTITY || ingestion.model.length > MAX_INGESTION_IDENTITY) {
    fail(`${names.ingestion} is too long; its combined provider and model identity must fit in ${MAX_INGESTION_IDENTITY} characters.`);
  }

  const bindings: readonly (readonly [string, readonly RoleEntry[]])[] = [
    [names.embedding, [embedding]],
    ...chatRoles.map((role) => [names[role], chat[role]] as const),
  ];
  const requireZdr = readRequireZdr(environment);
  for (const [variable, entries] of bindings) {
    for (const entry of entries) {
      const profile = profiles.get(entry.profile)!;
      if (options.requireCredentials && profile.apiKey === undefined && !profile.allowUnauthenticated) {
        fail(`${profile.variablePrefix}_API_KEY is required because profile "${profile.name}" is bound in ${variable}.`);
      }
      if (requireZdr && profile.privacy !== "enforced") {
        fail(`${names.requireZdr}=true refuses profile "${profile.name}" bound in ${variable}: ${profile.variablePrefix}_PRIVACY is ${profile.privacy}, not enforced.`);
      }
    }
  }

  return { profiles, embedding, chat, requireZdr };
}

/** Provider id recorded in embedding-space identity and audit records. */
export function profileProviderKind(profile: ProviderProfile): string {
  return profile.adapter.kind === "openrouter" ? "openrouter" : (profile.adapter.options.kind ?? OPENAI_COMPATIBLE_KIND);
}

/**
 * The identity an ingestion run records before the model call. A single
 * entry is that entry's own identity; a failover list records the whole
 * ordered list, because the serving entry is only known afterwards.
 */
export function ingestionIdentity(
  entries: readonly RoleEntry[],
  profiles: ReadonlyMap<string, ProviderProfile>,
): { readonly provider: string; readonly model: string } {
  return {
    provider: entries.map((entry) => profileProviderKind(profiles.get(entry.profile)!)).join(","),
    model: entries.map((entry) => entry.model).join(","),
  };
}

export interface ProfileProviderModels {
  readonly embeddingModel: string;
  readonly embeddingModelRevision?: string;
  readonly dimensions?: number;
  /** Used for every chat operation of this instance. */
  readonly chatModel: string;
}

/**
 * Builds the model provider for one profile. Adapter validation errors become
 * startup errors naming the profile, never the configured values.
 */
export function createProfileProvider(
  profile: ProviderProfile,
  models: ProfileProviderModels,
  observeRequest?: ModelRequestObserver,
  apiKeyOverride?: string,
): ModelProvider {
  const apiKey = apiKeyOverride ?? profile.apiKey;
  const shared = {
    ...(observeRequest === undefined ? {} : { observeRequest }),
    ...(apiKey === undefined ? {} : { apiKey }),
    embeddingModel: models.embeddingModel,
    ...(models.embeddingModelRevision === undefined ? {} : { embeddingModelRevision: models.embeddingModelRevision }),
    ...(models.dimensions === undefined ? {} : { dimensions: models.dimensions }),
    answerModel: models.chatModel,
    ingestionModel: models.chatModel,
    dreamingModel: models.chatModel,
    verificationModel: models.chatModel,
    requestTimeoutMs: profile.requestTimeoutMs,
  };
  try {
    return profile.adapter.kind === "openrouter"
      ? new OpenRouterProvider({ ...shared, baseUrl: profile.adapter.baseUrl, appTitle: "second-brain" })
      : new OpenAICompatibleProvider({ ...profile.adapter.options, ...shared });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid settings";
    throw new EngineStartupError(`${profile.variablePrefix}_* configuration is invalid: ${detail}`);
  }
}
