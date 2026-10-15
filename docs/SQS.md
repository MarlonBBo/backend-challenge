# Consumo de apostas por SQS

O consumidor inicia com a aplicação por padrão (`SQS_CONSUMER_ENABLED=true`). Usa o envelope `WagerTransactionRequested` do README. O `messageId` dentro do JSON identifica a mensagem na inbox; o `MessageId` gerado pelo SQS identifica a entrega no transporte. São identificadores distintos.

Exemplo de corpo:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-15T12:00:00.000Z",
  "correlationId": "request-123",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-123",
    "idempotencyKey": "provider-a:bet-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

A carteira deve existir. Publique na fila `wager-transactions.fifo` usando `MessageGroupId=walletId` e um `MessageDeduplicationId` estável para a publicação. Uma wallet compartilha um grupo FIFO; wallets distintas podem ser atendidas por instâncias diferentes. A deduplicação temporária do SQS complementa a inbox persistente, que continua protegendo mensagens reenviadas fora da janela do SQS.

## Atomicidade e deduplicação

O mesmo `ProcessWagerTransactionUseCase` atende HTTP e SQS. Na entrada SQS, a Unit of Work insere a inbox por `(consumerName, messageId)` antes do processamento e marca `processedAt` antes do commit. Wallet, transação, ledger, inbox e outbox compartilham a mesma transação PostgreSQL. O lock da carteira permanece responsável por serializar os movimentos financeiros.

O consumidor confirma a entrega com `DeleteMessage` somente quando o caso de uso retorna, após o commit. Se a confirmação falhar, a reentrega encontra a inbox e reproduz o resultado pela idempotência, sem outro ledger ou evento. Se o banco falhar antes do commit, inclusive a inbox é revertida e a mensagem pode ser tentada novamente.

O hash da inbox é SHA-256 do JSON canônico dos campos validados de `data`, incluindo a chave de idempotência. Metadados de transporte e correlação ficam fora desse hash. Reutilizar `messageId` com outro payload gera `INBOX_PAYLOAD_CONFLICT`. A idempotência financeira também protege a operação quando ela chega com outro `messageId`, ou pelos dois canais HTTP e SQS.

## Falhas e novas tentativas

| Situação | Comportamento |
| --- | --- |
| Processada, rejeitada por negócio ou `PENDING_REFERENCE` | Commit e ack; pendências passam ao worker de referências |
| Banco/rede indisponíveis, wallet ainda inexistente ou falha de ack | Sem ack; retry por visibilidade com backoff de 1 segundo até 5 minutos |
| Envelope inválido, conflito de inbox, chave de idempotência ou identificador externo | Envia à DLQ e só depois confirma a origem |
| Falha ao enviar à DLQ | Preserva a origem para outra tentativa |

O redrive configurado na fila principal leva falhas transitórias persistentes à DLQ após 5 recebimentos. Não há loop infinito de retries no consumidor. A DLQ recebe o corpo original e, em encaminhamentos explícitos, os atributos `failureCode` e `originalMessageId`. A publicação na DLQ também é at-least-once; duplicatas permanecem possíveis se o processo morrer entre o envio e o ack da origem.

Cada instância faz long polling de 10 segundos e processa uma mensagem por vez. A visibilidade padrão é de 30 segundos, renovada a cada 10 segundos durante o processamento. Os parâmetros estão em `.env.example` e são repassados pelo Compose. O heartbeat deve ser menor que o prazo de visibilidade. Em shutdown, o long polling é cancelado e a operação em andamento termina antes de fechar o cliente; uma entrega recebida após o início do shutdown tem a visibilidade devolvida imediatamente. Em encerramento forçado, a visibilidade expira e permite a reentrega segura.

Depois de atualizar o código, reconstrua o container:

```sh
docker compose --profile app up -d --build app
```

Os testes reais e suas variáveis estão descritos em [test/integration/README.md](../test/integration/README.md).
