# Plano: captura pelo WhatsApp (guardar informação pelo celular)

Status: **proposta para revisão** — nada implementado.

## 1. Objetivo

Mandar uma mensagem num **grupo específico do WhatsApp** (texto, depois áudio, link, foto) e ela virar conteúdo do cérebro: memória, tarefa, lembrete, decisão ou documento, sem abrir o painel.

## 2. Opções de integração

| Opção | Lê grupos? | Risco | Custo/esforço | Veredito |
|---|---|---|---|---|
| **A. WhatsApp Cloud API oficial** (Meta) | Só pela Groups API: exige **Official Business Account**, máx. **8 participantes**, entrada só por link de convite, não funciona em número usado no app Business. Sem endpoint de histórico; tudo por webhook | Baixo (suportado) | Conta Meta Business verificada, webhook HTTPS público, cobrança por mensagem | Boa se você conseguir OBA; difícil para uso pessoal |
| **A'. Cloud API, conversa direta** com o número do bot (sem grupo) | Não precisa de grupo: você manda mensagem para o número do bot | Baixo | Mesma conta Meta, sem exigência de OBA | Caminho oficial mais simples; deixa de ser "grupo" |
| **B. Gateway não oficial** (Baileys, whatsapp-web.js, Evolution API, WAHA) como "aparelho vinculado" a um chip dedicado | Sim, qualquer grupo, inclusive o que você já tem | **Viola os termos do WhatsApp; risco de banimento do número**. Use chip descartável, nunca o número principal | Container self-hosted + QR code; sem custo por mensagem | O que entrega exatamente "um grupo específico" hoje |
| **C. Telegram** (infra de bot já existe para lembretes) | Sim (grupo ou conversa com o bot), API oficial e gratuita | Baixo | Muito baixo | Alternativa recomendada se o WhatsApp não for obrigatório |

Recomendação: construir a captura como **canal plugável** (`CaptureSource`) e começar pelo **B com chip dedicado**, para atender o grupo escolhido, deixando A/A' e C como adaptadores seguintes. O restante do pipeline é o mesmo para todos.

Atenção: grupo com outras pessoas significa tratar dados delas (LGPD). Preferência: grupo só com você + o número do bot (2 participantes), ou a conversa "mensagens para você".

## 3. Arquitetura

```
 Celular ─▶ WhatsApp ─▶ gateway (Evolution/WAHA/Baileys)
                              │ webhook HTTPS + HMAC
                              ▼
                  apps/server: services/capture (novo)
        ┌────────────────────┴─────────────────────┐
        │ 1. verifica assinatura                     │
        │ 2. allowlist: grupo (JID) + remetentes     │
        │ 3. idempotência por messageId              │
        │ 4. normaliza em CaptureMessage             │
        │ 5. (voz) transcrição via papel AI_TRANSCRIPTION
        └────────────────────┬─────────────────────┘
                              ▼
        engine.invoke("ingestion_propose")  ← fluxo existente
                              ▼
        fila "Review learning" no painel  (e/ou confirmação por resposta no WhatsApp)
                              ▼
        ingestion_review → ingestion_commit  → memória/tarefa/lembrete/decisão
```

Princípios herdados do projeto: a saída do modelo não é confiável; **propor → revisar → commitar** em passos duráveis; toda escrita registra o autor.

### 3.1 CaptureMessage (contrato interno)

`{ source: "whatsapp-baileys" | "whatsapp-cloud" | "telegram", chatId, messageId, senderId, sentAt, text?, media?: [{type, url|bytes, mime}], replyToId? }`

### 3.2 Comandos e texto livre

| Entrada | Efeito |
|---|---|
| texto livre | `ingestion_propose` decide o tipo (memória/tarefa/...) e mostra candidatos para revisão |
| `#nota …` | memória |
| `#tarefa … amanhã` | tarefa |
| `#lembrar … 15/11 9h` | lembrete (entrega pelos canais já existentes, Slack/Telegram) |
| `#decisao … porque …` | decisão com justificativa |
| `#doc <título>` + texto/anexo | revisão de documento numa knowledge base |
| `#desfazer` | `*_retract/delete` do último item criado por mim |

### 3.3 Modelo de dados (migração aditiva, não mexe nas existentes)

- `capture_sources` (id, tipo, chat_id permitido, ativo, segredo do webhook criptografado)
- `capture_senders` (source_id, telefone/ID, `account_id` associado, papel efetivo ≤ `editor`)
- `capture_messages` (source_id, message_id **único**, payload bruto com expurgo em N dias, estado, `ingestion_run_id`)

O remetente é mapeado para uma conta existente; nenhuma mensagem de remetente fora da allowlist é gravada (nem o conteúdo é guardado).

## 4. Segurança e privacidade

- Webhook com HMAC e segredo por fonte; rejeitar timestamps antigos; resposta 200 rápida e processamento assíncrono pelo worker (Meta reenvia por até 7 dias em caso de falha, o que gera duplicatas: a unicidade de `message_id` resolve).
- Allowlist estrita de grupo e remetentes; todo o resto é descartado sem armazenar.
- Links: buscar o conteúdo exige proteção contra SSRF (bloquear IPs privados/loopback, limite de tamanho e tempo, sem redirecionar para rede interna). Fica para fase própria.
- Mídia e áudio vão para provedores de IA remotos; deixar explícito no painel, como já é feito para os demais dados.
- Gateway não oficial roda isolado (rede Docker própria), sem acesso ao banco; a sessão (credenciais do aparelho vinculado) fica em volume criptografado e é tratada como segredo.
- Previews e desenvolvimento usam **outro** número/grupo, nunca o de produção.

## 5. Fases

| Fase | Entrega | Critério de aceite |
|---|---|---|
| W0 | Spike local: Evolution API ou WAHA em Docker com chip dedicado; só registrar o payload de mensagens do grupo escolhido | Payload real de texto capturado e salvo como fixture anonimizada; decisão final do gateway |
| W1 | `services/capture`: webhook, HMAC, allowlist, idempotência, migração das 3 tabelas | Testes de unidade + integração com Postgres; mensagem duplicada não duplica efeito |
| W2 | Texto livre → `ingestion_propose` → revisão no painel | Fluxo ponta a ponta em ambiente de preview |
| W3 | Comandos `#nota/#tarefa/#lembrar/#decisao/#desfazer` | Testes por comando, incluindo datas em fuso do cérebro |
| W4 | Confirmação por resposta no WhatsApp ("salvei: …", 👍 confirma) | Resposta enviada só ao grupo permitido; falha de envio não perde a captura |
| W5 | Áudio: transcrição via papel `AI_TRANSCRIPTION` (depende do plano de provedores) | Nota de voz vira proposta com a transcrição como fonte citável |
| W6 | Imagens/OCR e links (com proteção SSRF) | Testes de segurança dedicados |
| W7 | Adaptador Cloud API (A/A') e/ou Telegram | Mesmo contrato `CaptureMessage`; mesma suíte de contrato |

Dependências: W5 usa o registro de provedores (`plano-provedores-ia.md`); testar W1+ em preview exige o ambiente por tag (`plano-branches-e-ambientes.md`, URL pública com HTTPS).

## 6. Perguntas em aberto

1. Aceita o risco do gateway não oficial com chip dedicado (B), ou prefere o caminho oficial (A') / Telegram (C)?
2. O grupo terá só você ou outras pessoas? (define o tratamento de privacidade)
3. Itens capturados entram direto ou sempre passam pela revisão no painel? (padrão proposto: revisão; confirmação rápida no WhatsApp opcional)
4. Quais tipos de conteúdo são prioridade: texto, voz, links, fotos?
5. Qual idioma principal das mensagens e dos comandos?
