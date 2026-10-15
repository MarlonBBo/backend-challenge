# Plano de Implementação — Distributed Wagering Processor

## 1. Objetivo

Entregar em três dias uma implementação sólida dos requisitos obrigatórios do desafio, priorizando:

1. correção financeira;
2. concorrência entre múltiplas instâncias;
3. idempotência persistente;
4. consistência entre wallet e ledger;
5. inbox, outbox e recuperação após falhas;
6. testes reais com PostgreSQL e SQS;
7. documentação clara das decisões e limitações.

A meta não é construir uma plataforma genérica. A meta é demonstrar, de forma simples e verificável, que o sistema permanece correto diante de duplicidade, concorrência, mensagens fora de ordem e falhas de processo.

## 2. Restrições de prazo

- Prazo total: **3 dias**.
- Ritmo previsto: **8 a 10 horas focadas por dia**.
- Capacidade estimada: **24 a 30 horas**.
- O núcleo financeiro e as falhas eliminatórias têm prioridade sobre acabamento e diferenciais.

## 3. Escopo

### 3.1 Incluído

- Bun 1.x, TypeScript estrito e NestJS.
- PostgreSQL e migrations reversíveis.
- MikroORM.
- AWS SQS por LocalStack.
- Docker Compose.
- Domínio financeiro com `Money`, `Wallet`, `WagerTransaction` e ledger.
- Operações `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- Idempotência persistente para HTTP e SQS.
- Controle de concorrência por wallet.
- Inbox e transactional outbox.
- Processamento de referências fora de ordem.
- Retry, backoff e DLQ.
- Reconciliação de saldo.
- Health checks, logs estruturados e métricas mínimas.
- Testes unitários, de integração e concorrência.
- `README.md` operacional e `ARCHITECTURE.md`.

### 3.2 Fora do escopo inicial

- Integração real com Keycloak ou Zitadel.
- Ledger de partidas dobradas.
- OpenTelemetry e dashboards.
- Teste de carga.
- Reversões parciais.
- Correção automática de divergências de reconciliação.
- Suporte operacional a moedas além de BRL.
- Abstrações genéricas sem uso imediato.

A autenticação será representada por um ponto de extensão explícito, como um guard no-op ou `ProviderIdentityPort`, e a decisão será documentada no `ARCHITECTURE.md`.

## 4. Definição de sucesso

A entrega será considerada pronta quando:

- dinheiro nunca for representado por `number`, `float` ou `double`;
- uma operação duplicada não duplicar débito ou crédito;
- duas operações concorrentes não provocarem saldo negativo nem lost update;
- cada alteração de saldo possuir exatamente um lançamento correspondente;
- transações sem alteração de saldo não criarem ledger;
- wallet, transação, ledger, inbox e outbox forem confirmados atomicamente;
- nenhuma mensagem SQS for confirmada antes do commit;
- eventos confirmados não forem perdidos após reinício;
- referências fora de ordem forem reprocessadas;
- três ou mais instâncias puderem operar corretamente;
- os testes terminarem verificando que o saldo persistido equivale ao saldo reconstruído pelo ledger;
- o projeto puder ser executado a partir das instruções do `README.md`.

## 5. Decisões técnicas iniciais

### 5.1 Stack

- Runtime, gerenciador e test runner: Bun.
- Framework: NestJS.
- ORM: MikroORM.
- Banco: PostgreSQL.
- Mensageria: SQS FIFO no LocalStack.
- Cálculo decimal: `decimal.js` ou biblioteca equivalente compatível com Bun.
- Validação dos contratos: biblioteca compatível com NestJS, sem levar decorators para o domínio.

### 5.2 Dinheiro

- A API recebe e devolve valores como string com exatamente duas casas decimais.
- O domínio usa `Money`, imutável, apoiado por uma biblioteca decimal.
- O banco usa `numeric` com escala 2.
- O adapter de persistência nunca converte dinheiro para `number`.
- BRL será a única moeda aceita operacionalmente, mas `Money` continuará validando moeda e impedindo operações entre moedas diferentes.

### 5.3 Concorrência

- A unidade de concorrência é `walletId`.
- Será usado lock pessimista na linha da wallet, equivalente a `SELECT ... FOR UPDATE`.
- Não haverá lock global.
- Wallets diferentes poderão ser processadas paralelamente.
- Outbox e workers usarão seleção por lote com `FOR UPDATE SKIP LOCKED`.

Essa estratégia foi escolhida por ser direta, segura e simples de demonstrar no prazo disponível.

### 5.4 Idempotência

- O header `Idempotency-Key` será a fonte da verdade na API HTTP.
- O payload será normalizado por JSON canônico, com chaves ordenadas.
- O hash será calculado somente sobre os campos de negócio.
- A mesma chave e o mesmo hash retornam o resultado original com `idempotentReplay: true`.
- A mesma chave com hash diferente retorna conflito.
- A resposta original, inclusive o saldo observado, será persistida ou reconstruída de dados imutáveis ligados à transação.
- A inbox deduplicará mensagens por `(consumerName, messageId)` e também guardará o hash do payload.

### 5.5 Garantia de eventos

- Eventos nunca serão publicados antes do commit financeiro.
- Cada evento será gravado na outbox dentro da transação SQL principal.
- O publisher terá semântica at-least-once.
- O `eventId` permanecerá estável entre tentativas.
- Consumidores deverão poder deduplicar eventos pelo `eventId`.

## 6. Arquitetura pretendida

```text
HTTP Controller ─┐
                 ├──> ProcessWagerTransaction use case
SQS Consumer ────┘              │
                                │ transação SQL
                                ├── WagerTransaction
                                ├── Wallet com lock por linha
                                ├── WalletLedgerEntry
                                ├── InboxMessage, quando aplicável
                                └── OutboxMessage

Outbox Publisher ───────> SQS/Event destination
Pending Reference Worker ─> reprocessa referências ausentes
Reconciliation Use Case ──> compara wallet com ledger
```

### 6.1 Camadas

- `domain`: entidades, value objects, eventos, erros e regras puras.
- `application`: casos de uso e portas.
- `infrastructure`: MikroORM, PostgreSQL, SQS, logs e métricas.
- `presentation`: controllers, DTOs, filtros HTTP e health checks.

O domínio não dependerá de NestJS, MikroORM ou tipos monetários do ORM.

## 7. Modelo de persistência inicial

### 7.1 `wallets`

Campos principais:

- `id`;
- `player_id`;
- `currency`;
- `balance`;
- `version`;
- `created_at`;
- `updated_at`.

Garantias:

- `UNIQUE (player_id, currency)`;
- `CHECK (balance >= 0)`;
- `CHECK (version >= 1)`;
- escala monetária definida no schema.

### 7.2 `wager_transactions`

Campos principais:

- identidade interna;
- provider e identidade externa;
- idempotency key e payload hash;
- wallet, player, rodada e jogo;
- tipo e status;
- valor e moeda;
- referência externa e interna;
- failure code;
- saldo observado no processamento;
- datas de criação e processamento;
- dados de tentativa para referência pendente.

Garantias:

- unicidade por provider e transação externa;
- unicidade da idempotency key no escopo documentado;
- checks de status, tipo e valores não negativos;
- índices para referências pendentes e consultas externas;
- restrição que ajude a impedir reversão duplicada do mesmo tipo.

### 7.3 `wallet_ledger_entries`

Campos principais:

- identidade;
- wallet e transação;
- direção;
- valor e moeda;
- saldo anterior e posterior;
- data de criação.

Garantias:

- `UNIQUE (wallet_id, transaction_id)`;
- checks de não negatividade;
- proteção contra `UPDATE` e `DELETE`, preferencialmente por trigger ou permissões do usuário da aplicação;
- validação da aritmética também no domínio.

### 7.4 `inbox_messages`

- `consumer_name`;
- `message_id`;
- `payload_hash`;
- `received_at`;
- `processed_at`.

Garantia principal: `UNIQUE (consumer_name, message_id)`.

### 7.5 `outbox_messages`

- identidade do evento;
- agregado e tipo;
- payload JSON versionado;
- data do evento;
- número de tentativas;
- próxima tentativa;
- data de publicação;
- lock/claim somente se necessário além do lock transacional.

Índice parcial para mensagens ainda não publicadas ordenadas por `next_attempt_at`.

## 8. Regras de processamento

### 8.1 `BET`

- Debita a wallet.
- Rejeita com `INSUFFICIENT_FUNDS` quando não houver saldo.
- Produz um ledger `DEBIT` somente quando processada.

### 8.2 `WIN`

- Credita a wallet.
- Pode referenciar uma aposta da mesma rodada.
- Produz um ledger `CREDIT`.

### 8.3 `LOSS`

- Registra o resultado.
- Não altera saldo.
- Não gera ledger.
- Gera `WagerTransactionProcessed`.

### 8.4 `REFUND`

- Exige referência a uma `BET` processada.
- Exige igualdade de valor.
- Credita a wallet.
- Só pode ocorrer uma vez para a mesma referência.

### 8.5 `ROLLBACK`

- Exige referência processada do tipo `BET`, `WIN` ou `REFUND`.
- Aplica a direção inversa da referência.
- Exige igualdade de valor.
- Só pode ocorrer uma vez para a mesma referência.
- Se a operação inversa causar saldo negativo, rejeita com código específico.

### 8.6 Referência ausente

- A operação passa para `PENDING_REFERENCE`.
- Um worker a reprocessa com backoff exponencial.
- O worker consulta a cada 1 segundo e processa até 25 operações por ciclo, uma transação por operação. Seleciona a carteira com `FOR UPDATE OF w SKIP LOCKED`, mantendo a ordem de locks usada pelo HTTP; uma carteira ocupada fica para outro ciclo.
- O contador começa em zero na aceitação e aumenta a cada tentativa do worker. O backoff é de 1 segundo inicialmente, depois 2, 4, 8 segundos, até 5 minutos. A próxima tentativa nunca ultrapassa o TTL.
- O limite padrão é de 20 tentativas ou 24 horas desde a criação, o que ocorrer primeiro. As tentativas limitam referências inválidas a cerca de uma hora sob operação contínua; o TTL também cobre longas indisponibilidades e reinícios. Ao atingir o TTL, a operação é rejeitada mesmo que a referência tenha chegado depois do prazo.
- Todos os parâmetros podem ser ajustados pelas variáveis `REFERENCE_*` de `.env.example`. O worker não sobrepõe ciclos e aguarda a transação em andamento durante o shutdown.
- A estratégia inicial será um número pequeno e documentado de tentativas, ajustável por configuração.
- Ao esgotar tentativas ou TTL, a operação passa para `REJECTED` com `REFERENCE_NOT_FOUND`.

## 9. Taxonomia inicial de falhas

Os nomes finais serão consolidados durante a implementação:

- `INSUFFICIENT_FUNDS`;
- `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE`;
- `CURRENCY_MISMATCH`;
- `WALLET_NOT_FOUND`;
- `WALLET_PLAYER_MISMATCH`;
- `REFERENCE_NOT_FOUND`;
- `INVALID_REFERENCE_KIND`;
- `REFERENCE_CONTEXT_MISMATCH`;
- `REFERENCE_AMOUNT_MISMATCH`;
- `REFERENCE_ALREADY_REFUNDED`;
- `REFERENCE_ALREADY_ROLLED_BACK`;
- `IDEMPOTENCY_CONFLICT`;
- `INVALID_TRANSACTION_STATE`;
- `INVALID_PAYLOAD`;
- `PERMANENT_INFRASTRUCTURE_FAILURE`.

Falhas de negócio são terminais e auditáveis. Falhas transitórias de infraestrutura provocam retry. Mensagens permanentemente inválidas seguem para DLQ.

## 10. Plano detalhado de três dias

## Dia 1 — núcleo financeiro e persistência

### Bloco 1: fundação

- [x] Inicializar Bun, NestJS e TypeScript estrito.
- [x] Adicionar lint e formatação mínimos.
- [x] Configurar PostgreSQL e LocalStack no Docker Compose.
- [x] Configurar MikroORM.
- [x] Criar mecanismo de configuração validada por ambiente.
- [x] Criar migration inicial, com `up` e `down`.
- [x] Criar scripts de desenvolvimento, migration e testes.

### Bloco 2: domínio

- [x] Implementar `Money` e suas validações.
- [x] Implementar `Wallet`.
- [x] Implementar `WagerTransaction` e estados terminais.
- [x] Implementar `WalletLedgerEntry` imutável.
- [x] Implementar inbox e outbox no domínio.
- [x] Implementar eventos de integração tipados.
- [x] Definir erros e failure codes.
- [x] Criar testes unitários do domínio.

### Bloco 3: primeiro fluxo vertical

- [x] Mapear persistência sem acoplar o domínio ao ORM.
- [x] Implementar criação da wallet.
- [x] Criar transação interna `OPENING` quando necessário.
- [x] Criar ledger de abertura no mesmo commit.
- [x] Implementar o caso de uso central de apostas.
- [x] Implementar lock pessimista por wallet.
- [x] Implementar hash canônico e idempotência.
- [x] Implementar BET e LOSS primeiro; depois WIN, REFUND e ROLLBACK.
- [x] Gravar outbox no mesmo commit.
- [ ] Expor os endpoints essenciais.

### Testes de saída do Dia 1

- [x] `Money` rejeita formatos inválidos e conflitos de moeda.
- [x] Wallet duplicada é impedida pelo banco.
- [x] Abertura cria saldo, transação e ledger atomicamente.
- [x] Uma aposta processada altera wallet e ledger.
- [x] Uma aposta rejeitada não cria ledger.
- [x] Duas apostas simultâneas de `80.00` sobre `100.00` resultam em uma processada e uma rejeitada.
- [x] O saldo final é `20.00` e existe apenas um débito.

### Critério de conclusão do Dia 1

O caminho HTTP principal funciona e a correção financeira foi provada sob concorrência real contra PostgreSQL.

## Dia 2 — mensageria, referências e recuperação

### Bloco 1: SQS e inbox

- [x] Criar fila `wager-transactions.fifo` e sua DLQ no LocalStack.
- [x] Implementar validação do envelope SQS.
- [x] Implementar consumidor que reutiliza o caso de uso central.
- [x] Registrar inbox na mesma transação financeira.
- [x] Confirmar a mensagem somente após o commit.
- [x] Classificar erros de negócio, transitórios e permanentes.
- [x] Configurar limite de recebimentos e DLQ.
- [x] Implementar graceful shutdown e controle de mensagens em andamento.

### Bloco 2: outbox

- [ ] Implementar busca em lote com `SKIP LOCKED`.
- [ ] Implementar publicação com `eventId` estável.
- [ ] Marcar publicação concluída.
- [ ] Reagendar falhas com backoff.
- [ ] Permitir publishers concorrentes.
- [ ] Medir tentativas e atraso da outbox.

### Bloco 3: referências fora de ordem

- [x] Persistir `PENDING_REFERENCE`.
- [x] Emitir `WagerTransactionPendingReference`.
- [x] Implementar worker de reprocessamento.
- [x] Aplicar backoff e limite de tentativas/TTL.
- [x] Rejeitar com `REFERENCE_NOT_FOUND` ao esgotar o limite.
- [x] Impedir REFUND e ROLLBACK duplicados.

### Bloco 4: consultas e operação

- [ ] Implementar consulta de wallet.
- [ ] Implementar ledger paginado por cursor estável e opaco.
- [ ] Implementar consultas de transação interna e externa.
- [ ] Implementar reconciliação sem correção automática.
- [ ] Implementar `/health/live`.
- [ ] Implementar `/health/ready` com PostgreSQL e SQS.

### Testes de saída do Dia 2

- [x] Redelivery da mesma mensagem não duplica efeitos.
- [x] Falha antes do commit permite retry seguro.
- [x] Falha depois do commit e antes do ack permite redelivery seguro.
- [ ] Dois publishers não perdem eventos.
- [x] REFUND/ROLLBACK anterior à referência é processado posteriormente.
- [x] Mensagem permanentemente inválida chega à DLQ.

### Critério de conclusão do Dia 2

Entradas HTTP e SQS compartilham as mesmas regras, e reinícios ou redeliveries não perdem nem duplicam efeitos financeiros.

## Dia 3 — testes, observabilidade e documentação

### Bloco 1: suíte crítica

- [ ] Executar a mesma aposta 50 vezes em paralelo e provar um único débito.
- [ ] Executar operações concorrentes disputando o saldo.
- [ ] Demonstrar paralelismo entre wallets distintas.
- [ ] Executar com pelo menos três processos/instâncias.
- [ ] Simular worker morto após commit e antes do ack.
- [ ] Executar dois publishers sobre a mesma outbox.
- [x] Testar referência entregue fora de ordem.
- [ ] Reiniciar os serviços e comprovar a consistência final.
- [ ] Verificar `wallet.balance == saldo reconstruído pelo ledger` em todos os testes relevantes.

### Bloco 2: observabilidade

- [ ] Implementar logs JSON.
- [ ] Propagar `correlationId`.
- [ ] Incluir IDs técnicos relevantes nos logs.
- [ ] Evitar payload financeiro completo e dados sensíveis.
- [ ] Expor métricas mínimas de status, duplicatas, retries, DLQ, locks, latência e outbox lag.
- [ ] Registrar divergências de reconciliação em log e métrica.

### Bloco 3: documentação e revisão

- [ ] Escrever `ARCHITECTURE.md`.
- [ ] Documentar estratégia transacional e de locks.
- [ ] Documentar Money e mapeamento no banco.
- [ ] Documentar estados e failure codes.
- [ ] Documentar hash canônico e escopo da idempotência.
- [ ] Documentar retry, backoff, TTL e DLQ.
- [ ] Documentar autenticação não implementada e ponto de extensão.
- [ ] Atualizar `README.md` com setup e comandos reproduzíveis.
- [ ] Revisar migrations reversíveis.
- [ ] Executar lint, typecheck e toda a suíte.
- [ ] Preparar roteiro curto de demonstração.

### Critério de conclusão do Dia 3

Um avaliador consegue subir o projeto, executar os testes e verificar as principais garantias sem depender de explicações externas.

## 11. Estratégia de testes

### 11.1 Unitários

- Formato, escala e serialização de `Money`.
- Entradas inválidas e notação científica.
- Operações entre moedas diferentes.
- Saldo insuficiente.
- Incremento de versão apenas quando o saldo muda.
- Máquina de estados da transação.
- Aritmética e imutabilidade do ledger.
- Regras de cada tipo de operação.
- Payload hash divergente para a mesma chave.

### 11.2 Integração

- Migrations e constraints reais.
- Atomicidade entre as tabelas.
- Locks reais do PostgreSQL.
- Inbox e redelivery no SQS real do LocalStack.
- Outbox com publishers concorrentes.
- Retry, DLQ e recuperação após reinício.

### 11.3 Concorrência

Testes usarão paralelismo real, barreiras para alinhar o início das operações quando necessário e timeouts explícitos. Mocks sequenciais não serão usados para provar concorrência.

## 12. Mapeamento HTTP inicial

O mapeamento final deverá ser consistente em todos os endpoints:

- `201 Created`: wallet ou transação criada e processada;
- `200 OK`: replay idempotente ou consulta;
- `202 Accepted`: transação aceita e aguardando referência/processamento;
- `400 Bad Request`: payload estruturalmente inválido;
- `404 Not Found`: recurso consultado inexistente;
- `409 Conflict`: wallet duplicada ou conflito de idempotência;
- `422 Unprocessable Entity`: rejeição por regra de negócio;
- `503 Service Unavailable`: dependência indisponível ou falha transitória.

A resposta carregará status e `failureCode` estável quando aplicável.

## 13. Observabilidade mínima

### Logs

Campos de contexto, quando existirem:

- `correlationId`;
- `messageId`;
- `transactionId`;
- `walletId`;
- `providerId`;
- `eventType`;
- `attempt`;
- `durationMs`.

### Métricas

- transações por status e tipo;
- duplicatas detectadas;
- conflitos de idempotência;
- retries de consumo e publicação;
- mensagens enviadas à DLQ;
- espera/conflitos de lock;
- latência de processamento;
- quantidade e idade da outbox pendente;
- referências pendentes;
- divergências de reconciliação.

## 14. Plano de contingência

Se houver atraso, preservar nesta ordem:

1. `Money`, ledger e constraints financeiras;
2. lock por wallet e teste de disputa de saldo;
3. idempotência persistente e replay correto;
4. atomicidade da inbox e outbox;
5. testes reais de integração e concorrência;
6. retry, DLQ e referências fora de ordem;
7. health, logs e métricas;
8. refinamento de documentação e ergonomia.

Não serão removidos para ganhar tempo:

- constraints do banco;
- ledger auditável;
- testes com PostgreSQL e SQS reais;
- transação SQL envolvendo efeitos financeiros e outbox;
- deduplicação persistente;
- suporte a múltiplas instâncias.

## 15. Riscos e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| Integração Bun/NestJS/MikroORM consumir tempo | Alto | Validar o bootstrap e migrations no primeiro bloco |
| Testes concorrentes ficarem instáveis | Alto | Usar barreiras, dados isolados e invariantes finais |
| ORM converter `numeric` para `number` | Eliminatório | Custom type/adapter baseado em string e testes de precisão |
| Lock ser adquirido tarde demais | Eliminatório | Centralizar processamento em uma única transação e travar a wallet antes de validar saldo |
| Replay devolver saldo atual | Alto | Persistir ou reconstruir o saldo observado no resultado original |
| Evento ser publicado antes do commit | Eliminatório | Publicação exclusiva pelo worker de outbox |
| Mensagem receber ack antes do commit | Alto | Ack somente após retorno bem-sucedido da transação |
| Escopo crescer durante a implementação | Alto | Manter itens opcionais fora até toda a suíte crítica passar |

## 16. Ordem de execução imediata

1. Bootstrap do projeto e Docker Compose.
2. Migrations com constraints.
3. `Money` e testes.
4. Wallet, transação e ledger.
5. Criação de wallet com `OPENING`.
6. Caso de uso central e lock por wallet.
7. Idempotência e outbox.
8. Teste concorrente obrigatório.
9. SQS, inbox e workers.
10. Suíte completa, observabilidade e documentação.

Este documento será atualizado durante a execução: itens concluídos devem ser marcados, decisões alteradas devem ser registradas e qualquer corte de escopo deve preservar as garantias financeiras e distribuídas.
