# Plano: provedores de IA configuráveis (sem hardcode de OpenRouter)

Status: P0, P1, P2 and **P3 shipped** (registry, per-role bindings, failover, `AI_REQUIRE_ZDR`; see section 8). P2b, P4 and P5 are pending.

## 1. Opinião

Vale fazer, e o custo é menor do que parece: o domínio já define interfaces separadas por papel (`EmbeddingProvider`, `AnswerProvider`, `IngestionProvider`, `DreamingProvider`, `DreamingVerificationProvider`, `BrainQuestionProvider`, todas em `apps/engine/src/domain/`). Hoje uma única classe, `OpenRouterProvider`, implementa todas. O trabalho real não é "trocar a URL": é (a) permitir **adaptadores diferentes por papel**, (b) tratar as diferenças de API entre provedores e (c) cuidar dos embeddings, que são a parte irreversível.

Recomendação: **registro de adaptadores + vínculo por papel**, mantendo OpenRouter como um adaptador (não removido) e compatibilidade total com as variáveis `OPENROUTER_*` atuais.

## 2. Onde o OpenRouter está acoplado hoje

| Local | Acoplamento |
|---|---|
| `providers/openrouter-provider.ts` | Todas as chamadas mandam `provider: { zdr: true, data_collection: "deny" }` (campo exclusivo do OpenRouter); `require_parameters`; cabeçalhos `x-title` / `http-referer`; embeddings com `input_type` e `dimensions`; respostas com `usage.cost` |
| `runtime-config.ts` | `createModelProvider` lê só `OPENROUTER_*` e instancia a classe direto; o nome `"openrouter"` entra na **identidade do embedding space** |
| `providers/model-configuration.ts` | Lista de modelos via `https://openrouter.ai/api/v1/endpoints/zdr`; sonda (`probe`) também fixa OpenRouter |
| `environment-configuration.ts` | Lista de variáveis permitidas/segredos do painel é só `OPENROUTER_*` |
| Painel admin (`configuration.tsx`, i18n) | Textos e fluxo "Test and activate your AI" falam em OpenRouter e ZDR |
| Esquema do banco | Colunas `vector(1536)` **fixas** (memórias, decisões, chunks) |
| Todas as chamadas de chat | `response_format: json_schema` com `strict: true` |

## 3. Desenho proposto

### 3.1 Perfis de provedor e vínculo por papel

```
# Perfis (quantos quiser)
AI_PROVIDER_<NOME>_KIND=openrouter | openai-compatible
AI_PROVIDER_<NOME>_BASE_URL=https://...
AI_PROVIDER_<NOME>_API_KEY=...            # segredo, criptografado como os outros overrides
AI_PROVIDER_<NOME>_PRIVACY=enforced | attested | none
AI_PROVIDER_<NOME>_STRUCTURED=json_schema | json_object | prompt
AI_PROVIDER_<NOME>_EXTRA_HEADERS=...      # opcional

# Papéis -> perfil + modelo
AI_EMBEDDING=<NOME>:<modelo>
AI_ANSWER=<NOME>:<modelo>
AI_INGESTION=<NOME>:<modelo>     # default: AI_ANSWER
AI_DREAMING=<NOME>:<modelo>      # default: AI_ANSWER
AI_VERIFICATION=<NOME>:<modelo>  # default: AI_ANSWER
AI_TRANSCRIPTION=<NOME>:<modelo> # novo; usado pela captura de WhatsApp (voz)
```

Compatibilidade: se nenhuma `AI_*` estiver definida, as variáveis `OPENROUTER_*` atuais continuam valendo e geram o perfil implícito `openrouter`. Nenhuma instalação existente muda de comportamento.

### 3.2 Adaptadores

| Adaptador | Cobre | Observações |
|---|---|---|
| `openrouter` | O comportamento atual, extraído para um adaptador | Mantém ZDR, `usage.cost`, catálogo ZDR |
| `openai-compatible` (genérico) | OpenCode Zen (`https://opencode.ai/zen/v1`), OpenAI, DeepSeek direto, Groq, Together, LiteLLM, vLLM, Ollama (`/v1`) | Só campos padrão (`/chat/completions`, `/embeddings`); sem `provider.*` |
| `anthropic` (protocolo `/messages`) | Modelos do OpenCode Go que **não** falam OpenAI (MiniMax, Qwen), Claude direto | Necessário se quiser esses modelos; ver seção 3.2.1 |

#### 3.2.1 OpenCode Zen e OpenCode Go

Mesma conta e **mesma chave de API** para os dois; mudam só a base URL e a cobrança:

| Produto | Base URL | Cobrança |
|---|---|---|
| Zen | `https://opencode.ai/zen/v1` | pré-pago por uso |
| Go | `https://opencode.ai/inference/go/openai/v1` (OpenAI) e `https://opencode.ai/inference/go/anthropic/v1` (Anthropic); o caminho antigo `https://opencode.ai/zen/go/v1` também respondeu | assinatura mensal com limite de uso por modelo (janelas de 5 h, semanal e mensal); pode cair para saldo do Zen |

- Ambos entram como **perfis** do adaptador `openai-compatible` (`AI_PROVIDER_OPENCODEGO_BASE_URL=https://opencode.ai/inference/go/openai/v1`, `AI_PROVIDER_OPENCODEZEN_BASE_URL=https://opencode.ai/zen/v1`), com a mesma chave em dois perfis ou perfis separados.
- No Go, `/chat/completions` atende GLM, Kimi, DeepSeek e MiMo; **MiniMax e Qwen só respondem em `/messages`** (formato Anthropic). Para usá-los, entra o adaptador `anthropic` (fase P2b). Sem ele, o primeiro corte usa só os modelos OpenAI-compatíveis.
- O identificador do modelo aparece como `glm-5.2` na documentação do Zen e como `opencode-go/glm-5.2` em alguns exemplos do Go. A forma aceita pela API é confirmada no spike da P2 (não presumir).
- Limite de assinatura significa **HTTP 429 em uso intenso** (ingestão e dreaming rodam em lote): o adaptador genérico precisa de retry com espera e de falha limpa por papel, em vez de derrubar o worker.
- Privacidade: a documentação do Go declara retenção zero e sem treino, mas isso é uma declaração do provedor, então o perfil fica como `PRIVACY=attested`, não `enforced`.
- `GET /zen/go/v1/usage` existe mas é endpoint não documentado; não depender dele.
- Embeddings: nenhum dos dois lista modelos de embedding; ficam no OpenRouter (decisão do usuário: OpenCode para chat, OpenRouter para embeddings e como reserva).

### 3.3 Capacidades por perfil (o que muda de um provedor para outro)

- **Saída estruturada.** Ordem de degradação: `json_schema` strict → `json_object` + validação Zod → prompt + validação Zod, sempre com **uma** nova tentativa de reparo. A saída do modelo já é tratada como não confiável (README), então a validação existente continua sendo a barreira.
- **Privacidade (ZDR).** Hoje é política imposta pelo código. Com outros provedores só dá para *atestar*. O campo `PRIVACY` registra isso e o painel mostra o nível por papel. Opção `AI_REQUIRE_ZDR=true` recusa iniciar com qualquer papel cujo perfil não seja `enforced`.
- **Custo.** O registro de uso só guarda custo reportado pelo provedor e nunca estima (README). Provedores sem `usage.cost` gravam `null`; tokens continuam contabilizados.
- **Catálogo de modelos.** Passa a ser um método opcional do adaptador; o genérico usa `GET /models` quando existir, senão campo de texto livre.
- **Cabeçalhos/atribuição.** Só o adaptador OpenRouter envia `x-title` / `http-referer`.

### 3.4 Embeddings: a decisão que não se desfaz fácil

- A identidade do embedding space é `provider + model + revision + dimensions + metric`. **Trocar qualquer um exige o ciclo de re-embedding** já descrito no README (criar space `preparing`, re-embedar tudo, verificar, promover atomicamente). Não há capability MCP para isso; é manutenção do operador.
- As colunas são `vector(1536)`. Modelo que não gera 1536 nativamente precisa aceitar o parâmetro `dimensions` (Matryoshka: `text-embedding-3-*`, Gemini embedding) ou exige migração de esquema (nova coluna/tabela e reindexação).
- O OpenCode Zen, até onde a documentação consultada mostra, lista só modelos de chat. Logo o vínculo por papel é o que permite **chat no Zen e embeddings em outro lugar** (OpenAI, OpenRouter, Ollama local com modelo de 1536 dims ou truncado).
- Recomendação: escolher o provedor de embeddings **uma vez, antes de ter dados** e deixá-lo fora do uso de preview/dev (preview usa o mesmo provedor para não quebrar fixtures).

### 3.5 Painel admin

- Configuração passa a listar perfis e a tabela papel → perfil/modelo, com "testar" por papel (sonda sintética já existente, generalizada).
- Allowlist de variáveis (`environment-configuration.ts`) ganha os nomes `AI_*`; chaves são segredos.
- Textos sobre ZDR viram "nível de privacidade do perfil".

## 4. Fases

| Fase | Entrega | Critério de aceite |
|---|---|---|
| P0 | Teste de contrato dos provedores: fixtures de resposta (chat, json_schema, embeddings, erros, timeout, abort) rodando contra `OpenRouterProvider` | Passa hoje; vira a especificação que todo adaptador precisa cumprir |
| P1 | Extrair interface de adaptador e o registro; mover o código atual para o adaptador `openrouter` sem mudar comportamento | Suíte inteira + P0 verdes; diff de comportamento zero; `OPENROUTER_*` funciona sem nenhuma `AI_*` |
| P2 | Adaptador `openai-compatible` com degradação de saída estruturada e retry em 429; perfis OpenCode **Zen e Go** | P0 verde também para ele; testado contra servidor fake e, em spike manual, contra Zen **e Go** reais (json_schema strict, formato do id do modelo, 429) |
| P2b | Adaptador `anthropic` (`/messages`, saída estruturada por `tool_use` forçado) para **Qwen** (e MiniMax) do Go | Mesmo contrato de P0; **no escopo: Qwen foi escolhido pelo usuário** |
| P3 | Vínculo por papel (`AI_*`), validação de inicialização, `AI_REQUIRE_ZDR` | Testes de composição; falha fechada em configuração inconsistente |
| P4 | Painel: perfis, tabela de papéis, sonda por papel, i18n en/pt-BR/es | Testes de componente; verificação visual |
| P5 | Runbook de troca de embeddings (re-embedding) e, se desejado, capability de operador | Procedimento testado em banco de preview |

Cada fase vai por branch a partir da `main` → PR para `develop` (ver `plano-branches-e-ambientes.md`), com `npm run test:changed` durante o desenvolvimento e `npm run test:regression` antes do PR.

## 5. Riscos

- Provedores "compatíveis com OpenAI" divergem em detalhes (campos ignorados, `strict` não suportado, `dimensions` rejeitado). Mitigação: capacidades declaradas no perfil + P0 como contrato + sonda no painel.
- Perda da garantia ZDR sem aviso. Mitigação: `PRIVACY` visível e `AI_REQUIRE_ZDR`.
- Re-embedding caro e demorado se a escolha inicial for ruim. Mitigação: decidir cedo (seção 3.4).
- Termos de uso: assinaturas de ferramentas de código (ex.: planos do OpenCode Go) podem não permitir uso por aplicações de terceiros; confirmar nos termos antes de depender delas em produção.

## 6. Perguntas em aberto

1. ~~Quais provedores no primeiro corte?~~ Respondido: **OpenCode (Zen e Go) para chat, OpenRouter para embeddings e reserva**. Modelos preferidos: **Qwen** (3.8 Flash/Max, 3.7 Plus) e **DeepSeek V4.1 Flash**; Qwen exige a P2b.
2. Embeddings: qual provedor/modelo? Aceita o 1536 fixo ou prefere migrar o esquema?
3. ZDR é requisito seu ou pode ser só informativo?
4. Mantemos compatibilidade com `OPENROUTER_*` indefinidamente (recomendado) ou migramos de vez?

## 7. Resultado do spike de P2 (2026-10-22, chamadas reais, chave Go do usuário)

| Teste | Resultado |
|---|---|
| Go `GET /zen/go/v1/models` | 200, 36 modelos (inclui `deepseek-v4.1-flash`, `qwen3.8-flash`, `qwen3.8-max`, `qwen3.7-plus`) |
| DeepSeek V4.1 Flash, `POST /inference/go/openai/v1/chat/completions`, `response_format: json_schema` **strict** | **200**, JSON válido; `json_object` também funciona |
| Qwen3.8 Flash, `POST /inference/go/anthropic/v1/messages`, `tool_choice` forçado | **200**, `tool_use` com o objeto; resposta traz bloco `thinking` |
| Zen `POST /zen/v1/chat/completions` com a chave pré-paga | **402 "Insufficient account funds"**: a conta Zen está sem saldo (Go funciona, Zen não, até recarregar) |
| Qualquer chamada do Go com `User-Agent` padrão de biblioteca (ex.: Python-urllib) | **403 `error code: 1010`** (bloqueio do edge) |
| Go sem cabeçalho `x-opencode-session` | **400 `MissingSessionID`** |

Consequências para o adaptador:

1. Enviar `User-Agent: second-brain/<versão>` próprio (nunca o padrão do HTTP client) e `x-opencode-session` estável por conversa/job (ex.: id do job de dreaming, do run de ingestão ou da pergunta).
2. DeepSeek e Qwen são modelos de **raciocínio**: tokens de raciocínio contam em `completion_tokens` e `max_tokens` baixo trunca a resposta (`{"ok":` cortado). O adaptador precisa de orçamento de tokens maior e, quando possível, desligar/limitar o raciocínio.
3. `usage` não traz custo em dinheiro: `cost = null` (o projeto nunca estima).
4. Qwen só pelo adaptador `anthropic` (P2b); a saída estruturada é por `tool_use` forçado, validada pelo mesmo Zod.
5. Tratar 402 (sem saldo/limite), 429 (janela de uso) e 403 1010 como erros classificados e acionáveis no painel.
6. Retenção declarada pelo OpenCode: Qwen e DeepSeek "não usados para treino, 0 dias"; o acordo ZDR do DeepSeek é renovado mensalmente (válido até 31/10/2026 na data da consulta). Perfil `PRIVACY=attested`.

### Risco de termos do Go (decisão do usuário)

A documentação do Go diz que ele é "desenhado para o OpenCode e outros agentes de código que produzem requisições semelhantes", com monitoramento de abuso, e pede que o cliente (1) envie tráfego típico de agente de código, (2) se identifique com user agent próprio e (3) envie `x-opencode-session`. O Second Brain atende 2 e 3, **mas não 1**: ingestão, dreaming e perguntas sobre memórias não são tráfego de agente de código. Risco: limitação ou suspensão da assinatura. Mitigações: volume baixo, identificação honesta, OpenRouter como reserva por papel, e a alternativa **Zen pré-pago** (mesmos preços por token; para o volume de um cérebro pessoal tende a custar centavos por mês) como caminho sem ambiguidade de termos.

## 8. P3 status: provider registry and per-role bindings (shipped)

### What shipped

- `apps/engine/src/providers/provider-registry.ts` parses the `AI_*` environment into named provider profiles and role bindings.
- `apps/engine/src/providers/composite-provider.ts` implements every model role interface (`EmbeddingProvider`, `AnswerProvider`, `IngestionProvider`, `DreamingProvider`, `DreamingVerificationProvider`, `BrainQuestionProvider`) and delegates each operation to the provider bound to that role. Runtime consumers are unchanged.
- `createModelProvider` / `createConfiguredModelProvider` (`runtime-config.ts`) select the composition:
  - **No registry variable set** (none of `AI_PROVIDERS`, `AI_EMBEDDING*`, `AI_ANSWER`, `AI_INGESTION`, `AI_DREAMING`, `AI_VERIFICATION`, `AI_PROVIDER_*`): exactly the previous `OpenRouterProvider` built from `OPENROUTER_*`. The contract test `test/contract/provider-registry-wire.test.ts` proves that the requests still match the P0 goldens. Unrelated names such as `AI_AGENT` never switch modes; empty values count as unset.
  - **Any registry variable set**: the registry is used, `OPENROUTER_*` is ignored, and `AI_PROVIDERS` becomes mandatory.
- `AI_REQUIRE_ZDR=true` refuses to start when the privacy level of any bound profile is not `enforced`. Only `KIND=openrouter` can be `enforced`; the legacy OpenRouter path always satisfies it.
- The MCP HTTP entrypoint checks `OPENROUTER_API_KEY` on the legacy path, or the key of every bound profile with the registry.
- The admin configuration store accepts the new names (see "Admin allowlist"). There is no admin UI yet (P4).

### Variables

| Variable | Meaning |
|---|---|
| `AI_PROVIDERS` | Comma list of profile names (letters and digits, case-insensitive). Only listed profiles are read; the environment is not scanned to discover profiles. |
| `AI_PROVIDER_<NAME>_KIND` | `openrouter` or `openai-compatible`. Optional when `_PRESET` implies it. |
| `AI_PROVIDER_<NAME>_PRESET` | `opencode-go`, `openai`, `ollama` or `openrouter`. Loads the `provider-presets.ts` defaults; explicit variables override them. |
| `AI_PROVIDER_<NAME>_BASE_URL` | Required for `openai-compatible` without a preset. HTTPS, or HTTP on loopback only. |
| `AI_PROVIDER_<NAME>_API_KEY` | Secret. Required for every bound profile except the `ollama` preset. |
| `AI_PROVIDER_<NAME>_PRIVACY` | `enforced` (OpenRouter only), `attested` or `none`. Defaults: OpenRouter `enforced`, otherwise the preset value, otherwise `none`. |
| `AI_PROVIDER_<NAME>_STRUCTURED` | `json_schema`, `json_object` or `prompt` (OpenRouter accepts only `json_schema`). |
| `AI_PROVIDER_<NAME>_EXTRA_HEADERS` | JSON object of header names to string values. |
| `AI_PROVIDER_<NAME>_USER_AGENT`, `_SESSION_HEADER`, `_MIN_COMPLETION_TOKENS`, `_SEND_DIMENSIONS` | OpenAI-compatible adapter options (rejected for `openrouter`). |
| `AI_PROVIDER_<NAME>_REQUEST_TIMEOUT_MS` | Per-profile timeout, default 30000. |
| `AI_EMBEDDING` | Exactly one `<profile>:<model>`. |
| `AI_EMBEDDING_REVISION` | Embedding model revision, default `provider-managed`. |
| `AI_EMBEDDING_DIMENSIONS` | Must be 1536 (the vector columns are `vector(1536)`). |
| `AI_ANSWER` | Required. Ordered failover list `<profile>:<model>[,<profile>:<model>...]`, at most 5 entries. |
| `AI_INGESTION`, `AI_DREAMING`, `AI_VERIFICATION` | Same format; default to `AI_ANSWER`. |
| `AI_REQUIRE_ZDR` | `true` or `false` (default). |

`AI_TRANSCRIPTION` (section 3.1) is not implemented yet; it arrives with the WhatsApp capture work.

### Failover rules

- A chat role tries its entries in order. It moves to the next entry only on a retryable provider condition: 429 after the adapter's own retries, any 5xx (including 503 after retries), 402 (credits or usage limit), 403 (blocked), a network failure, or a provider timeout.
- It never fails over on 400, 401, 404 or other client errors, on malformed responses, invalid completions or validation failures, or when the caller's signal is aborted (including the caller's own deadline). When every entry fails, the classified error of the last entry is thrown.
- The usage hook (`ModelRequestObservation`) records every attempt with its own `model`, so the entry that served is visible in the usage records. The composition also accepts an internal `onServed` callback (used by tests); nothing new is persisted.
- Dreaming records the identity of the entry that actually served. An ingestion run stores its identity before the model call, so a failover list records the whole ordered list (for example provider `opencode-go,openrouter`, model `deepseek-v4.1-flash,deepseek/deepseek-v4-flash`); a single entry records itself.
- **Embeddings never fail over**, and `AI_EMBEDDING` rejects a list at startup: vectors from different models must never mix in one embedding space.

### Fail-closed startup errors

Every case below raises an `EngineStartupError` that names the variable and never prints a secret value:

- registry variables without `AI_PROVIDERS`;
- an unknown profile in a binding;
- a missing key for a bound profile (validated runtimes only; the lenient composition defers it to the first call, like the legacy path);
- an `AI_EMBEDDING` list, or dimensions other than 1536;
- an unknown preset, kind, privacy level or structured output mode, or a kind that contradicts the preset;
- `PRIVACY=enforced` on a non-OpenRouter profile, or OpenAI-compatible-only settings on an OpenRouter profile;
- malformed numbers, booleans or JSON;
- settings for an unlisted profile or with an unknown suffix (typos);
- malformed, empty, repeated or too many list entries;
- `AI_REQUIRE_ZDR=true` with any bound profile that is not `enforced`;
- adapter validation failures, for example a reserved extra header or a plain-HTTP remote base URL.

### Example: OpenRouter only

Nothing changes for existing installs: keep the `OPENROUTER_*` variables and set no `AI_*` variable. The equivalent registry form keeps the same embedding identity (`openrouter`):

```
AI_PROVIDERS=or
AI_PROVIDER_OR_KIND=openrouter
AI_PROVIDER_OR_API_KEY=<key>
AI_EMBEDDING=or:google/gemini-embedding-001
AI_EMBEDDING_REVISION=provider-managed
AI_ANSWER=or:deepseek/deepseek-v4-flash
```

### Example: OpenCode Go for chat, OpenRouter for embeddings and failover

```
AI_PROVIDERS=go,or
AI_PROVIDER_GO_PRESET=opencode-go
AI_PROVIDER_GO_API_KEY=<opencode key>
AI_PROVIDER_OR_KIND=openrouter
AI_PROVIDER_OR_API_KEY=<openrouter key>
AI_EMBEDDING=or:google/gemini-embedding-001
AI_EMBEDDING_REVISION=provider-managed
AI_ANSWER=go:deepseek-v4.1-flash,or:deepseek/deepseek-v4-flash
# AI_INGESTION, AI_DREAMING and AI_VERIFICATION default to AI_ANSWER.
```

`AI_REQUIRE_ZDR=true` refuses this setup, because the Go profile is `attested`, not `enforced`.

### Embedding-space warning

The embedding identity comes only from the `AI_EMBEDDING` profile: `provider + model + revision + dimensions`. When you switch an existing install to the registry, keep `AI_EMBEDDING` on the same OpenRouter model and revision as the current `OPENROUTER_EMBEDDING_MODEL` and `OPENROUTER_EMBEDDING_MODEL_REVISION`. The provider id stays `openrouter`, so the existing embedding spaces still match. Any other value (another model, revision or provider, for example `openai` or `ollama`) makes startup refuse the active embedding spaces and requires the re-embedding cycle (section 3.4, phase P5).

### Admin allowlist

`environment-configuration.ts` keeps the fixed `OPENROUTER_*` catalog. It also accepts `AI_PROVIDERS`, `AI_ANSWER`, `AI_INGESTION`, `AI_DREAMING`, `AI_VERIFICATION`, and `AI_PROVIDER_<NAME>_<SUFFIX>` for every suffix except `BASE_URL`. `_API_KEY` values are encrypted secrets. Registry settings are listed only after they are stored.

Like `OPENROUTER_BASE_URL` and `OPENROUTER_EMBEDDING_MODEL`, these names stay operator-only (environment):

- `AI_PROVIDER_<NAME>_BASE_URL`, so that a stored override cannot send a configured key to another endpoint;
- `AI_EMBEDDING*`, the embedding identity;
- `AI_REQUIRE_ZDR`, the privacy policy.

### Model configuration (admin probe and catalog)

- The catalog (`models()`) stays OpenRouter-specific (`/endpoints/zdr`).
- With the registry, `probe()` accepts `<profile>:<model>` to test a model on that profile; a bare model is probed on the primary profile of `AI_ANSWER`. `status()` reports whether every bound profile has a key and lists the role bindings as `profile:model` lists.

### Known gaps

- `compose.yaml` forwards only the `OPENROUTER_*` variables (and requires `OPENROUTER_API_KEY`). Compose deployments need the `AI_*` variables added to the service environment before they can use the registry. P3 does not change or verify this (no Docker run).
- There is no admin UI for profiles or roles (P4); the admin panel copy still talks about OpenRouter.
- The registry does not expose the `opencode-zen` preset (only OpenCode Go is in scope). Qwen and MiniMax on Go still need the `anthropic` adapter (P2b).
