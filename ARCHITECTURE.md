# Arquitetura e decisões

## Camadas

`domain` contém regras puras, Money e entidades, sem dependência de NestJS ou ORM. `application` coordena casos de uso por portas. `infrastructure` implementa PostgreSQL, SQS, workers e telemetria. `presentation` valida contratos HTTP e traduz resultados. HTTP e SQS usam o mesmo processamento financeiro.

## Dinheiro e ledger

Money usa decimal.js; contratos e persistência usam strings decimais e PostgreSQL `numeric(20,2)`, nunca conversão para `number`. O modelo carrega moeda e rejeita conflitos; a operação pública limita-se a BRL. O saldo inicial positivo cria uma transação interna OPENING e um crédito no mesmo commit. Saldo inicial zero não cria movimento fictício.

BET debita; WIN credita e seu prêmio pode diferir da aposta referenciada; LOSS não movimenta. REFUND credita uma BET processada de mesmo valor. ROLLBACK inverte BET/WIN/REFUND, também com igualdade de valor e sem permitir saldo negativo. Referências devem respeitar o contexto da operação. Reversões parciais estão fora do escopo.

Cada movimento cria um ledger imutável com saldo anterior/posterior. Constraints garantem saldo não negativo, unicidade por wallet/transação, identidade externa e idempotência. Um trigger impede UPDATE/DELETE do ledger. Isso não protege contra um administrador que deliberadamente remova o trigger.

## Transação, locks e idempotência

A Unit of Work abre uma transação PostgreSQL. O processamento obtém `FOR UPDATE` na wallet antes de validar e modificar o saldo; wallets diferentes não compartilham lock global. O UPDATE também exige a versão anterior esperada. Transação, saldo, ledger, inbox e outbox são confirmados juntos. Falha de infraestrutura desfaz o conjunto.

A chave HTTP `Idempotency-Key` é global entre transações de apostas; `(providerId, externalTransactionId)` também é único. O hash SHA-256 usa JSON canônico dos campos de negócio, inclusive referência e Money normalizado. Não inclui correlationId nem metadados de transporte. Mesma chave/hash retorna o resultado persistido, não o saldo atual; divergência retorna 409. A identidade externa com outra chave é conflito. Leituras são repetidas após o lock; a consulta externa também reconhece replay se outro processo tiver acabado de confirmar a mesma chave.

## Estados, referências e mensageria

As transações chegam a PROCESSED, REJECTED ou PENDING_REFERENCE. Este último não movimenta saldo e pode terminar posteriormente. Os códigos de falha são definidos em `src/domain/wagering/failure-code.ts`; contratos e exemplos estão em [consultas](docs/QUERIES.md) e [SQS](docs/SQS.md).

O worker de referências bloqueia primeiro a wallet, com SKIP LOCKED, na mesma ordem do HTTP. Aplica backoff de 1 segundo até 5 minutos, limite padrão de 20 tentativas e TTL de 24 horas. Esgotamento gera REFERENCE_NOT_FOUND. A correlação original é recuperada do evento pendente, inclusive após reinício. Não há sobreposição de ciclos no mesmo worker.

A inbox persiste `(consumerName, messageId)` e hash na transação financeira. O consumidor só confirma a mensagem depois do commit. Visibility timeout, heartbeat, retries e DLQ permitem recuperação; SQS é canal interno confiável, mas seu payload continua validado. Veja [SQS](docs/SQS.md).

O publisher seleciona outbox com SKIP LOCKED e só publica eventos já confirmados. Publicação e confirmação no PostgreSQL não são uma transação distribuída: uma queda depois do envio pode duplicar a entrega. A garantia é **at-least-once**, com eventId estável para deduplicação pelo consumidor. FIFO não equivale a exactly-once nem garante ordem causal global entre publishers. O envio ocorre enquanto o lote mantém locks, uma escolha simples com custo de conexões/tempo de transação; veja [outbox](docs/OUTBOX.md).

## Reconciliação

`POST /api/wallets/:walletId/reconciliation` compara saldo materializado com créditos menos débitos, incluindo OPENING, em uma única consulta e um único snapshot MVCC. Retorna valores exatos, diferença assinada, quantidade de entradas e conflitos de moeda. Wallet vazia reconcilia com zero. Detecta e registra divergência, mas **não corrige dados**. A diferença é `storedBalance - calculatedBalance`. Não substitui auditoria de encadeamento de todos os saldos históricos.

## Operação e segurança

`GET /health/live` verifica o processo sem consultar dependências. `GET /health/ready` verifica PostgreSQL e as três filas SQS, retornando 503 se indisponíveis. A resposta tem timeout; uma consulta PostgreSQL já iniciada pode continuar até o timeout do driver. Health fica fora de `/api`.

`GET /metrics` expõe texto Prometheus por processo: resultados de submissões por status/tipo, duplicatas, conflitos de idempotência, retries, encaminhamentos à DLQ, espera/conflitos de lock, latência, publicação/atraso da outbox e divergências. Séries surgem conforme uso; contadores reiniciam com o processo. Transições posteriores do worker não são novas submissões. Quantidade de referências pendentes e profundidade aproximada da DLQ são atualizadas pelas sondagens de readiness. Não há coletor, dashboard, agregação entre instâncias ou alerta configurado.

Logs de execução usam JSON e AsyncLocalStorage para IDs técnicos; HTTP aceita/gera e devolve `x-correlation-id`. Não se registram corpos financeiros nem SQL de debug. O logger filtra campos de objetos e omite stacks de exceções; mensagens textuais devem continuar sem dados sensíveis. Não há tracing distribuído OpenTelemetry.

Autenticação foi deliberadamente omitida no timebox. `ProviderAuthGuard` é um guard global **no-op**, não uma proteção. A evolução seria integrar um IdP externo OIDC, validar assinatura/issuer/audience/expiração do JWT e vincular claims ao providerId autorizado. Health permaneceria aberto e SQS interno. Nunca criaríamos autenticação artesanal com tabela de senhas. Até essa integração, não expor a API ou `/metrics` publicamente; usar rede confiável.

## Evidências e limites

Testes unitários cobrem regras; integração usa PostgreSQL e LocalStack; a suíte distribuída inicia três processos com PIDs distintos, disputa saldo, envia 50 duplicatas, verifica wallets independentes, referência fora de ordem, morte abrupta após commit antes de ack e reinício com publicação da outbox. Reconcilia os saldos dos cenários. Isso verifica correção, não throughput ou capacidade de produção.

Não estão incluídos teste de carga, dupla entrada contábil, correção automática, autenticação real ou SLA. Migrações destrutivas de rollback exigem ambiente isolado/backup. Veja as instruções de execução e testes no [README](README.md).
