# Primeiros passos com o Second Brain 1.0

> Este guia em inglês: [This guide in English](./getting-started.en.md)

Este guia instala um servidor privado do Second Brain e o conecta a qualquer
cliente MCP compatível com descoberta OAuth, registro dinâmico de cliente e
Authorization Code com PKCE, ou com um token bearer estático na mesma URL MCP.

O Second Brain 1.0 é uma versão somente para instalação nova. Não o conecte a
um banco de dados ou volume Docker criado por uma versão anterior. Não existe
atualização in-place nem importação automática.

## Antes de começar

Você precisa de:

- uma máquina ou VPS com Docker Engine e Docker Compose v2;
- um hostname HTTPS público para acesso MCP remoto;
- uma conta OpenRouter, uma chave de API e um limite de gastos explícito;
- o código-fonte do Second Brain;
- um plano de backup para o PostgreSQL.

Node.js 22.20 ou mais recente também é necessário para desenvolvimento local.
O deploy com Compose compila e executa o Node dentro da imagem.

O servidor armazena seus dados, mas o processamento dos modelos é remoto. O
texto necessário para embeddings, respostas fundamentadas, ingestão revisada e
dreaming diário é enviado pelo OpenRouter a provedores de modelos. O serviço
solicita roteamento com retenção zero e nega coleta de dados pelos provedores
por padrão; revise as políticas antes de armazenar informações sensíveis.

## 1. Crie um ambiente novo

Copie a configuração de exemplo:

```sh
cp .env.example .env
```

Abra `.env` e substitua pelo menos:

- `POSTGRES_PASSWORD` por uma senha de banco exclusiva;
- `OPENROUTER_API_KEY` pela sua chave;
- `SECOND_BRAIN_PUBLIC_URL` pela origem HTTPS final, sem caminho;
- `SECOND_BRAIN_PUBLIC_HOST` pelo hostname dessa origem;
- `SECOND_BRAIN_CONFIG_ENCRYPTION_KEY` por um base64url canônico de 32 bytes
  aleatórios.

Gere a chave de criptografia uma vez e mantenha um backup:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Mantenha `.env` privado. Não faça commit nem cole esse arquivo em uma conversa
com IA.

Para testes OAuth somente locais, uma origem HTTP loopback é aceita. Um deploy
remoto deve usar HTTPS e manter o PostgreSQL e as portas de diagnóstico dos
serviços vinculados a `127.0.0.1`.

## 2. Inicie a stack v1 limpa

Inicie os serviços:

```sh
docker compose up -d --build
docker compose ps
```

Acompanhe os logs de inicialização:

```sh
docker compose logs -f migrate auth engine admin automation-worker
```

O serviço `migrate` aplica as migrations Drizzle incluídas na ordem do journal
antes de iniciar os outros serviços. Ele recusa um schema `public` não
gerenciado e não vazio, verifica ordem e checksums das migrations e usa um
advisory lock do PostgreSQL para impedir duas migrations simultâneas.

Se a migration relatar uma migration desconhecida, ausente, reordenada ou
alterada, pare. Não edite o ledger nem uma migration aplicada para forçar a
inicialização. Confirme que o banco é novo e que a imagem e o diretório
`drizzle/` pertencem à mesma build.

## 3. Faça o bootstrap da primeira conta

Execute o bootstrap inicial da conta em um terminal interativo:

```sh
docker compose run --rm auth node dist/services/auth/bootstrap-account.js
```

Informe um e-mail e uma senha forte. A transação cria:

- uma conta com UUID que recebe o papel `owner`;
- as configurações de automação do deploy, com UTC como fuso inicial;
- embedding spaces ativos para memórias, decisões e chunks de conhecimento,
  vinculados ao provedor/modelo/revisão configurado e às receitas v1.

Repetir exatamente o e-mail normalizado, a senha e a identidade do provedor
verifica a conta ativa, o papel dela, a linha única de configurações e os três
spaces, e retorna os mesmos IDs. Qualquer divergência ou corrupção falha de
forma fechada e nunca cria uma segunda conta. Uma configuração inválida do
OpenRouter ou do provedor de embeddings também falha antes de gravar.

O deploy atende exatamente um brain, e o bootstrap não o cria nem o nomeia.
A versão 1.0 não inclui uma superfície para provisionar contas adicionais nem
para gerenciar papéis.

O bootstrap é somente interativo. Execute-o em um terminal confiável e nunca
coloque a senha da conta em `.env`, Compose, argumentos de deploy ou logs. Sem
suporte TTY em stdin/stdout, ele falha com
`Account bootstrap requires an interactive terminal.`

### Configure o painel administrativo

Reinicie os runtimes de modelo depois do bootstrap do owner:

```sh
SECOND_BRAIN_DEPLOY_MODE=wait-engine bash deploy/deploy.sh
```

Abra `${SECOND_BRAIN_PUBLIC_URL}/admin` e entre pelo servidor OAuth existente
com uma conta ativa `admin` ou `owner`. O painel usa Authorization Code com S256
PKCE e não cria outra identidade ou senha. Ele é servido pelo serviço `admin`
endurecido via Traefik, enquanto sua porta de diagnóstico 3002 fica vinculada
ao loopback por padrão.

## 4. Conecte um cliente MCP compatível com OAuth

Use esta URL de servidor no cliente:

```text
https://seu-host.example/mcp
```

Um cliente compatível descobre o recurso protegido e o servidor de autorização,
registra-se dinamicamente, abre o login no navegador, solicita consentimento e
descobre o catálogo de ferramentas. Entre com a conta criada na seção 3.

Este repositório verifica o limite genérico dos protocolos MCP e OAuth. Ele não
afirma que uma versão específica do ChatGPT, Claude, Cursor ou Codex seja
certificada. Telas de configuração e comportamento de seleção de ferramentas
mudam de forma independente.

Se o cliente mantiver um catálogo antigo em cache, remova a conexão do servidor
e adicione-a novamente. O catálogo v1 tem 55 capabilities e inclui
`context_get`, `brain_search`, navegação de documentos de conhecimento, as
quatro etapas de ingestão revisada e `dreaming_report_get`.

## 5. Conecte com um token bearer estático

OAuth permanece ativo quando você adiciona um token estático. Defina os dois
valores no `.env` e recrie o serviço `engine`:

```sh
# INVOKTA_HTTP_BEARER_TOKEN precisa ter pelo menos 32 caracteres.
# INVOKTA_HTTP_PRINCIPAL_ID é o UUID impresso pelo bootstrap.
docker compose up -d engine
```

Use a mesma URL de servidor. Envie o token como credencial HTTP bearer:

```text
https://seu-host.example/mcp
Authorization: Bearer SEU_TOKEN
```

Mantenha `INVOKTA_HTTP_AUTH_MODE=oauth` para que clientes OAuth no navegador
continuem funcionando. O modo exclusivo `INVOKTA_HTTP_AUTH_MODE=bearer`
desliga o OAuth e serve apenas deploys que não precisam do servidor de
autorização.

O token vincula-se a uma conta ativa existente. Ele não concede um papel. O
papel atual da conta no banco continua sendo verificado em cada invocação.

## 6. Teste o contexto compartilhado

Peça ao cliente para chamar `context_get` no início de uma sessão. Inclua um
propósito curto, como "continuar a decisão de arquitetura do backend". A
resposta é um snapshot limitado das memórias, decisões, tarefas, lembretes,
metas e prioridades relevantes do brain, mais o catálogo de knowledge bases e
um índice de pessoas. Para perguntas do tipo "quem é" ou "o que você sabe
sobre", chame `brain_search` para buscar memórias, documentos e pessoas juntos.

Depois, teste a continuidade:

1. Crie uma tarefa, memória ou decisão em um cliente conectado.
2. Abra outro cliente compatível com a mesma conta.
3. Chame `context_get`, `brain_search` ou `brain_ask` a partir desse cliente.
4. Confirme que a resposta cita o registro armazenado.

Vincular um registro a um projeto é opcional. Toda capability que aceita
`projectId` também aceita o payload sem ele, e um registro sem projeto é
informação geral. Em uma atualização, omitir `projectId` mantém o projeto atual
e enviar um `null` explícito desvincula o registro.

Use `handoffs_create` para salvar uma nota limitada de continuação antes de
trocar de cliente e `handoffs_list` para recuperá-la. O servidor garante dados
compartilhados quando uma ferramenta é chamada; ele não pode obrigar um modelo
de terceiros não controlado a chamar ferramentas automaticamente.

Na ingestão de conversas, mantenha a extração do modelo separada das escritas:

1. chame `ingestion_propose` com o trecho e uma chave de idempotência;
2. revise o conjunto de propostas citadas;
3. chame `ingestion_review` para aceitar ou rejeitar propostas persistidas;
4. chame `ingestion_commit` para o conjunto revisado;
5. use `ingestion_status` depois de uma tentativa repetida ou resposta perdida.

## 7. Ative o dreaming com segurança

O worker de automação inicia com a stack, mas o dreaming diário fica desativado
por padrão e seu modo inicial seguro é `preview`. A versão 1.0 deliberadamente
não tem capability MCP para iniciar uma execução, mudar uma agenda ou ativar
apply.

Ativação, fuso horário, horário local diário, limites de execução e política de
apply são configurações operacionais confiáveis. Configure-as no painel
administrativo protegido por OAuth. Imponha limites de gastos em dólares no
dashboard do OpenRouter; o worker não impõe um orçamento local em USD. Não
exponha uma atualização de banco ou o entry point do worker a um cliente de IA
como substituto.

Em **Revisão noturna**, use **Configurar modelo e chave de API** para abrir o
modelo diário. Em **Ajustes**, informe sua chave e use **Teste e ative sua IA**
para escolher a função e buscar modelos com ZDR e respostas estruturadas.
Execute **Testar esta configuração** para verificar o modelo com a chave editada
ou salva. Cada teste é uma pequena chamada paga com conteúdo de exemplo.
O catálogo é uma referência; o teste confirma o roteamento atual com sua chave.

O modelo salvo no painel tem prioridade sobre o ajuste do servidor. O assistente
mostra o modelo efetivo, incluindo padrões do servidor. Salve as alterações e
use **Aplicar ajustes**. Compare a versão salva com a versão observada em cada
serviço, especialmente `automation-worker`. Uma observação ausente ou expirada
não confirma a ativação. Editar o modelo ou a chave invalida o resultado do teste
exibido; o teste em si nunca salva nem ativa a configuração.

Abra **Consumo de IA** para comparar chamadas, tokens informados, créditos
cobrados, duração e falhas por função ou modelo. O monitoramento começa nesta
versão; custos ausentes permanecem desconhecidos e totais podem ser parciais.
Avisos opcionais de consumo em 30 dias aparecem nesta página e ficam salvos neste
navegador. Incluem todas as funções independentemente dos filtros, não interrompem
chamadas e excluem custos não informados. Prompts, respostas e chaves não são
armazenados nos registros de consumo.

Volte a **Revisão noturna**, configure horário e fuso juntos, escolha o modo da
revisão e salve o agendamento. O fuso determina tanto o horário quanto o dia civil
revisado. A data da próxima execução é identificada como o horário do seu
dispositivo; ela pode diferir do horário local agendado.

Se uma revisão falhar com `DREAMING_PROVIDER_FAILED`, confira a chave do
OpenRouter, os créditos e a compatibilidade do modelo pelo link de
configuração ao lado do erro. Esse código genérico não identifica a causa no
provedor. Uma revisão encerrada com falha não tem mais tentativas automáticas.
Selecione o dia em **Calendário de revisões** para inspecionar as tentativas e
abrir um relatório concluído. Após corrigir o provedor, escolha **Reprocessar em
prévia** na tentativa com falha. Isso cria um novo job com o fuso e o período
originais, usando o modelo atualmente carregado. A tentativa original e os
efeitos anteriores permanecem intactos. O novo job sempre gera uma prévia.
Pedidos simultâneos reutilizam o mesmo reprocessamento; se ele falhar, pode ser
reprocessado novamente. Tentativas em execução ou concluídas não são reiniciadas.

Solicitar a mesma data em **Rodar agora** ainda retorna o job canônico existente;
use a ação do calendário para reprocessar uma tentativa com falha.

Abra **Revisar aprendizados** para inspecionar propostas importadas e sugestões
de prévias diárias concluídas. Escolha a origem e alterne entre sugestões
pendentes e o histórico. Em aprendizados importados, aprove ou rejeite cada
sugestão, escolha **Salvar revisão** e confirme **Aplicar sugestões aprovadas**.
Tarefas sem lista de destino devem ser rejeitadas. Salvar decisões ainda não
cria registros.

Nas sugestões diárias, compare **Memória atual** com **Memória proposta** e leia
a evidência de origem. **Aprovar** verifica as evidências novamente e pode usar
modelos pagos para verificar e indexar uma nova versão da memória. Memórias
alteradas, evidências removidas e análises incompletas impedem a aprovação.
**Rejeitar** salva a decisão sem alterar memórias nem usar IA. A aprovação
preserva o relatório original e registra o resultado no histórico de revisões.

Quando ativado por operações confiáveis, o worker processa o último dia civil
concluído no fuso IANA do brain. Ele grava um relatório limitado com insights
citados e propostas de memória. Os efeitos automáticos se limitam à criação
fundamentada de memórias e atualizações de versão verificadas separadamente;
ele nunca altera tarefas, lembretes, decisões, documentos, pessoas, projetos,
metas, prioridades ou permissões.

Os clientes leem um resultado armazenado com `dreaming_report_get`. A
capability pode selecionar o relatório mais recente, uma data local ou um ID de
execução. Ela nunca inicia um job nem chama um modelo. `report: null` significa
que não existe relatório concluído correspondente.

## 8. Use o espaço de trabalho no navegador

O **Início** abre com uma caixa de pergunta. Pergunte sobre memórias,
documentos, pessoas, projetos, decisões, metas e tarefas atuais. As respostas
incluem fontes numeradas, trechos e links para documentos. Se os registros
encontrados não responderem à pergunta, o painel informa isso. A busca e as
respostas podem gerar custos de IA. **Parar** cancela a solicitação atual; uma
resposta atrasada não substitui uma pergunta mais recente. A mesma caixa fica
disponível em todas as páginas como painel lateral: selecione **Pergunte ao seu
cérebro** no cabeçalho ou pressione Ctrl+J (⌘+J no Mac). Dentro de um projeto
ou pasta de documentos, o painel busca primeiro nesse contexto; troque para
**Cérebro inteiro** para ampliar.

Abra **Projetos** e selecione um projeto para visualizar seu contexto vinculado.
As contagens cobrem todos os registros correspondentes; cada seção carrega uma
página por vez. Expanda **Ler detalhes** para inspecionar o conteúdo salvo,
abrir documentos ou concluir e reabrir tarefas. **Perguntar sobre este projeto**
limita a pergunta ao projeto. Decisões e memórias atuais são exibidas em vez de
versões substituídas.

Abaixo da caixa de pergunta, o **Início** mostra tarefas e lembretes vencidos,
prazos das próximas 24 horas, verificações que precisam de atenção, o último
resumo noturno com suas questões abertas e quantas sugestões de memória
aguardam sua aprovação. Leia as evidências antes de escolher **Criar
tarefa** ou **Criar lembrete**. Revise o texto, selecione uma lista de tarefas e
um projeto opcional, ou informe um horário futuro para o lembrete, e confirme.
Você pode criar uma lista de tarefas na própria janela. As datas do formulário
usam o fuso do navegador.

Concluir uma tarefa ou lembrete vinculado, ou usar **Marcar como revisada**,
remove a questão do Início. Marcar como revisada preserva o relatório
e não conclui trabalhos existentes. Esses blocos não consultam um modelo e
informam quando suas listas limitadas omitem registros adicionais. A entrega de novos
lembretes precisa ser configurada separadamente da criação do lembrete.

## 9. Receba lembretes no Slack ou Telegram

Abra **Lembretes** no painel. A página separa configuração de canais, gerenciamento
dos lembretes e histórico de entregas. O proprietário adiciona um canal e segue as
instruções do serviço. Use um bot dedicado e convide-o somente para o destino desejado.
Os tokens ficam criptografados; deixar o token em branco na edição mantém o atual.

Salvar um canal ativo verifica o acesso do bot sem enviar mensagem de teste. Depois,
selecione **Ativar envios** e confirme: cada canal ativo recebe todos os lembretes
pendentes no horário, inclusive atrasados. O texto fica visível para as pessoas no
destino. Crie lembretes nesta página ou a partir de um insight do Início. Os horários do painel
usam o fuso do navegador.

Use **Concluir** para encerrar um lembrete ou **Adiar** para escolher um horário
futuro e solicitar outra entrega. A entrega não conclui o lembrete. Pausar interrompe
novos envios, mas não recolhe mensagens em andamento. Uma alteração no lembrete ou
canal pode cancelar uma entrega antiga na fila; adie para programar uma nova.

O histórico distingue aguardando, enviando, entregue, nova tentativa, cancelado,
falhou e entrega não confirmada. Limitações de frequência geram até cinco tentativas,
respeitando o intervalo do provedor. Envios não confirmados não são repetidos
automaticamente: confira o Slack ou Telegram antes de solicitar outra entrega, pois
o provedor pode tê-la recebido. Após corrigir um canal com falha, adie o lembrete.

## Privacidade e apagamento de conta

O apagamento de conta não é uma capability MCP. Isso impede que um cliente de IA
solicite uma exclusão de toda a conta. A camada de
persistência tem uma transação interna de apagamento que pseudonimiza autoria,
remove artefatos OAuth e exclui a linha da conta. O conteúdo do brain pertence
ao deploy, e não a uma conta, então ele permanece com a autoria daquela conta
removida.

Se a conta apagada era a última conta do deploy, o operador pode executar o
bootstrap novamente para criar um owner substituto. O conteúdo, as
configurações e os embedding spaces pertencentes ao deploy permanecem no lugar.

Um operador de produção deve expor essa transação somente por um fluxo
administrativo separado, autenticado e controlado por uma pessoa antes de
anunciar exclusão self-service. Coordene o apagamento de dados ativos com a
retenção de backups: excluir uma conta ativa não apaga backups anteriores até
que eles expirem.

Capabilities de exclusão de tarefas, lembretes e memórias são destrutivas,
exigem papel administrativo e usam chaves de idempotência. Seu alcance é
estreito: excluir tarefa/lembrete remove a entidade canônica e suas versões,
links e estado de entrega próprios; excluir memória remove somente essa linhagem
da recuperação/histórico de memórias. Trechos independentes de fontes de
ingestão, evidências/relatórios de dreaming e prosa de handoffs exigem o fluxo de
retenção ou apagamento responsável por essas cópias. Revise o contrato antes da
invocação.

## Atualizações e backups

Faça backup de todo o banco PostgreSQL, incluindo estado OAuth e chaves de
assinatura. Restaurar somente o conteúdo não restaura o serviço completo.

Antes de um deploy:

1. execute `npm run check`;
2. execute `npm run test:postgres` no serviço de teste isolado;
3. faça backup do PostgreSQL;
4. publique uma imagem imutável com os arquivos correspondentes de migration em `drizzle/`;
5. verifique os logs de `migrate`, `auth`, `engine`, `admin` e
   `automation-worker`.

Nunca edite uma migration que já foi aplicada. Gere uma nova migration Drizzle
para uma mudança deliberada de schema.

Mudar o modelo de embedding, a revisão do modelo, a receita, as dimensões ou a
métrica de distância exige uma operação controlada de re-embedding. Novos
vetores entram em um embedding space `preparing`, são verificados quanto à
cobertura completa e qualidade de recuperação e são promovidos de forma
atômica. Não renomeie nem compare vetores de spaces diferentes.

## Solução de problemas

### A migration se recusa a executar

Confirme que este é um banco v1 novo e que a imagem corresponde ao diretório de
migrations. Um erro de checksum ou ordem é uma parada de segurança. Não exclua
linhas do ledger, não renomeie arquivos de migration nem reutilize um volume de
uma versão anterior do produto.

### Um comando local rejeita a conta

Invocação direta interna e confiável exige uma conta UUID existente:

```sh
export SECOND_BRAIN_ACCOUNT_ID="SUBSTITUA_PELO_UUID_DA_CONTA"
```

Não existe identidade interna padrão. A conta deve estar ativa e ter um papel
que permita a capability. Clientes públicos se conectam por MCP HTTP protegido
por OAuth ou por um token bearer estático configurado.

### O cliente conecta, mas não usa o contexto

Descobrir ferramentas não controla o comportamento do modelo. Diga ao cliente
explicitamente para chamar `context_get` ou coloque essa chamada em um harness
controlado de início de sessão. Use `handoffs_create` antes de trocar de cliente
quando a continuação for importante.

### O relatório de dreaming está vazio

`report: null` é esperado quando o dreaming está desativado, nenhuma execução
diária foi concluída ou a data/execução selecionada não existe. A capability de
relatório nunca acorda o worker. Como operador, verifique configurações
confiáveis de automação, heartbeats do worker e logs sanitizados.
