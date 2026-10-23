# Plano: provedores de IA configuráveis (sem hardcode de OpenRouter)

Status: **proposta para revisão** — nenhum código foi alterado.

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
| Go | `https://opencode.ai/zen/go/v1` | assinatura mensal com limite de uso por modelo (janelas de 5 h, semanal e mensal); pode cair para saldo do Zen |

- Ambos entram como **perfis** do adaptador `openai-compatible` (`AI_PROVIDER_OPENCODEGO_BASE_URL=https://opencode.ai/zen/go/v1`, `AI_PROVIDER_OPENCODEZEN_BASE_URL=https://opencode.ai/zen/v1`), com a mesma chave em dois perfis ou perfis separados.
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
| P2b | Adaptador `anthropic` (`/messages`) para MiniMax/Qwen do Go (opcional) | Mesmo contrato de P0; só se esses modelos forem desejados |
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

1. ~~Quais provedores no primeiro corte?~~ Respondido: **OpenCode (Zen e Go) para chat, OpenRouter para embeddings e reserva**. Falta decidir se MiniMax/Qwen (P2b) interessam.
2. Embeddings: qual provedor/modelo? Aceita o 1536 fixo ou prefere migrar o esquema?
3. ZDR é requisito seu ou pode ser só informativo?
4. Mantemos compatibilidade com `OPENROUTER_*` indefinidamente (recomendado) ou migramos de vez?
