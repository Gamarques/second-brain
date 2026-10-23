# Plano: branches e ambientes (main / develop / preview)

Status: **proposta para revisão** — nada abaixo, além do fluxo de branches e dos dois workflows de guarda, foi implementado.

## 1. Fluxo de branches

```
main      ●───────────────●────────────●   produção (deploy automático)
           \             / \          /
develop     ●──●────●───●   ●────●───●     integração + ambientes de teste por tag
             \/    /          \  /
feature/*     ●──●─●            ●          sempre criada a partir da main
```

Ordem combinada:

1. `git checkout main && git pull && git checkout -b feat/minha-mudanca`
2. Alterar, rodar `npm run test:changed` (ver `docs/testing.md`).
3. PR **para `develop`**. CI roda (`Typecheck, test, and build` + `PostgreSQL 15 integration tests`).
4. Com `develop` verde, opcionalmente criar uma tag para abrir um ambiente de teste (seção 3).
5. PR `develop` → `main` quando o ambiente de teste estiver aprovado. Isso dispara o deploy de produção.

Regras:

| Item | Regra |
|---|---|
| Nome de branch | `feat/…`, `fix/…`, `docs/…`, `chore/…`; urgências: `hotfix/…` |
| Título do PR | Conventional Commits (`feat: …`, `fix: …`) — o `release-please` gera o CHANGELOG e a versão a partir deles |
| feature → develop | **Squash merge** (um commit limpo por feature) |
| develop → main | **Merge commit** (nunca squash). Squash faria `main` e `develop` divergirem e todo PR seguinte reapresentaria os mesmos commits |
| Hotfix | Sai da `main`, PR para `main`, depois back-merge `main` → `develop` |
| Feature criada da `main` | Funciona, mas ela não enxerga o que já está só na `develop`. Se depender de algo não lançado, crie a partir da `develop` |

### Aplicação das regras

- Proteção de branch (PR obrigatório, checks obrigatórios) **não está disponível**: o repo é privado em plano gratuito (a API devolve 403 "Upgrade to GitHub Pro or make this repository public"). Opções: GitHub Pro, ou seguir por disciplina.
- Enquanto isso, `.github/workflows/branch-flow.yml` falha (check vermelho) em qualquer PR para `main` cuja origem não seja `develop` ou `hotfix/*`. É um aviso visível, não um bloqueio: o botão de merge continua habilitado.
- `ci.yml` agora também roda em push na `develop`.

## 2. Estado atual dos workflows (achados)

Ao fazer o merge da PR #1 na `main`, dois workflows rodaram e falharam. Estão registrados em `docs/TODO-BUGS.md` (TODO-005 e TODO-006), sem correção:

- **Deploy** (`deploy.yml`) dispara a cada push na `main` e falha no passo de SSH porque `VPS_HOST`, `VPS_USER` e `VPS_SSH_KEY` não estão configurados. Quando houver VPS, isso passa a ser o deploy de produção real, então precisa de um portão (seção 4).
- **Release** (`release.yml`) cria a branch `release-please--branches--main--components--second-brain` mas não abre a PR: *"GitHub Actions is not permitted to create or approve pull requests"*. Solução: Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests". A branch órfã criada pode ser apagada.

## 3. Ambiente de teste por tag (preview)

Objetivo: ao subir uma tag em um commit da `develop`, abrir um ambiente completo e isolado, acessível por URL própria, que se destrói sozinho depois de X tempo.

### Gatilho

- Tag `preview/<nome>` ou `preview/<nome>-ttl72h` em um commit alcançável a partir da `develop` (o workflow recusa tags de commits fora da `develop`).
- TTL padrão: **48 h** (variável `PREVIEW_DEFAULT_TTL_HOURS`). O sufixo `-ttlNh` sobrescreve, com máximo de 168 h.
- `workflow_dispatch` com ações `extend` (+N h) e `destroy`.

### O que é criado (na mesma VPS, projeto Compose separado)

| Recurso | Preview | Produção |
|---|---|---|
| Projeto Compose | `sb-<nome>` | `second-brain` |
| Diretório | `/opt/second-brain-previews/<nome>/` | `/opt/second-brain/` |
| Banco | volume novo (`postgres-data` do projeto) | volume de produção |
| Host | `<nome>.dev.<domínio>` (wildcard `*.dev.<domínio>`, certificado por DNS-01 no Traefik) | `<domínio>` |
| Portas publicadas no host | nenhuma (só pela rede do Traefik) | loopback para diagnóstico |
| `SECOND_BRAIN_CONFIG_ENCRYPTION_KEY` | gerada nova por ambiente | a de produção |
| Chave do provedor de IA | chave **separada** com teto de gasto baixo | a de produção |
| Dados | nenhum dado de produção; só fixtures | reais |
| Owner | `bootstrap-noninteractive.js`, senha vinda de um segredo do GitHub Environment `preview`, via stdin | manual, interativo |

Fluxo do workflow `deploy-preview.yml`:

1. Valida a tag e o ancestral `develop`; calcula `expires_at`.
2. `npm run check` (ou reaproveita o resultado do CI do mesmo SHA).
3. Constrói a imagem `ghcr.io/<repo>:<sha>` (reaproveita o job de build do `deploy.yml`).
4. Via SSH: cria o diretório, gera `.env` do preview, escreve o rótulo `sb.expires=<epoch>` e sobe com `docker compose -p sb-<nome> up -d`.
5. Roda bootstrap do owner e o healthcheck de `engine`, `auth` e `admin`.
6. Comenta a URL e o horário de expiração na PR / no commit.

### Destruição

- `deploy/reap-previews.sh` na VPS, chamado por um timer do systemd a cada 15 min: para cada projeto `sb-*` com `sb.expires` vencido, `docker compose -p … down -v` e remove o diretório.
- Reforço: um workflow agendado (`cron`) que lista os previews e alerta sobre os que passaram do limite.
- Limite de **2 previews simultâneos**; o terceiro derruba o mais antigo ou recusa (decidir na revisão).

### Dimensionamento

Cada ambiente são 5 containers (postgres, auth, engine, admin, worker), em torno de 0,7–1 GB de RAM. Com produção + 2 previews a VPS precisa de **pelo menos 4 GB** (recomendado 6–8 GB) e de disco para os volumes do Postgres.

### Segurança

- Previews usam GitHub Environment `preview` (segredos separados dos de `production`).
- `X-Robots-Tag: noindex` e, opcionalmente, IP allowlist ou autenticação básica no Traefik.
- Nunca restaurar backup de produção em preview sem anonimização.
- Chave de IA do preview com limite de gasto no painel do provedor (o worker não aplica orçamento local).

### Alternativa mais barata

O próprio `npm run dev` já sobe a pilha isolada em Docker local. Para testar sozinho, não precisa de VPS; o preview por tag serve para mostrar o resultado a outras pessoas e para testar webhooks externos (WhatsApp, OAuth de clientes MCP), que exigem URL pública com HTTPS.

## 4. Portão de deploy de produção

Proposta (não implementada): o `deploy.yml` só roda se a variável de repositório `DEPLOY_ENABLED == 'true'`, e usa o GitHub Environment `production`. Sem VPS configurada, o workflow fica "skipped" em vez de falhar a cada merge.

## 5. Ordem de implementação

| # | Entrega | Depende de |
|---|---|---|
| E0 | Fluxo de branches, `branch-flow.yml`, CI na `develop` (**feito nesta PR**) | — |
| E1 | Portão `DEPLOY_ENABLED` + corrigir TODO-005/006 | decisão sobre VPS |
| E2 | VPS provisionada (`deploy/vps-setup.sh`), domínio, Traefik, wildcard DNS-01 | domínio e VPS |
| E3 | `deploy-preview.yml` + `reap-previews.sh` + testes do script de expiração | E2 |
| E4 | Comentário automático na PR e comandos de extend/destroy | E3 |

## 6. Perguntas em aberto

1. Já existe VPS e domínio? Qual provedor (Hostinger, como no template)? Quanto de RAM?
2. TTL padrão de 48 h está bom? Limite de 2 previews simultâneos?
3. Aceita o repo continuar privado sem proteção de branch, ou quer assinar o GitHub Pro?
4. Preview precisa de URL aberta na internet ou basta VPN/IP allowlist?
