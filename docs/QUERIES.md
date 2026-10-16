# Consultas de carteira e transações

Todas as rotas usam o prefixo `/api`, retornam JSON e consultam o estado confirmado no PostgreSQL. Não alteram saldo, versão, transações, ledger, inbox ou outbox. Cada leitura usa um novo `EntityManager.fork()`, sem lock pessimista e sem reutilizar entidades de consultas anteriores.

## Carteira

```http
GET /api/wallets/:walletId
```

Retorna `id`, `playerId`, `balance`, `version`, `createdAt` e `updatedAt`. O saldo é o valor atual da carteira, com `amount` como string decimal e `currency` como código da moeda. As datas são strings ISO-8601 em UTC.

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "version": 2,
  "createdAt": "2026-10-15T12:00:00.000Z",
  "updatedAt": "2026-10-15T12:00:01.000Z"
}
```

## Transação

```http
GET /api/wagering/transactions/:transactionId
GET /api/providers/:providerId/wagering/transactions/:externalTransactionId
```

As duas rotas retornam o mesmo formato, incluindo:

- Identificação: `id`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId` e `gameId`.
- Operação: `kind`, `status` e `money`.
- Resultado: `balance`, `failureCode` e `processedAt`.
- Referência: `referenceExternalTransactionId`, `referenceTransactionId`, `referenceAttempts` e `nextReferenceAttemptAt`.
- Data de criação: `createdAt`.

`balance` é o saldo observado no processamento da transação, não o saldo atual da carteira. Uma BET que deixou o saldo em `75.00` continua retornando `75.00` mesmo após um WIN posterior. Para acompanhar o saldo atual, consulte a carteira.

Campos opcionais sem valor são retornados como `null`. Uma transação `PENDING_REFERENCE` mostra o contador e a próxima tentativa, sem `processedAt`. Operações rejeitadas continuam consultáveis com seu `failureCode`. Hashes de payload e chaves de idempotência não fazem parte da resposta.

O identificador interno deve ser UUID. Os identificadores de provedor e transação externa são strings canônicas de até 100 e 255 caracteres, respectivamente. Use URL encoding em valores com caracteres especiais. A busca externa sempre considera o par `(providerId, externalTransactionId)`; dois provedores podem usar o mesmo identificador externo.

## Respostas HTTP

| Situação | Status e código |
| --- | --- |
| Carteira ou transação encontrada, inclusive rejeitada ou pendente | `200` |
| Parâmetro de rota inválido | `400 INVALID_PATH_PARAMETER` |
| Carteira inexistente | `404 WALLET_NOT_FOUND` |
| Transação inexistente no ID ou provedor informado | `404 TRANSACTION_NOT_FOUND` |

Falhas de infraestrutura não são convertidas em recurso inexistente. Consultas são leituras pontuais; chamadas separadas de carteira e transação podem observar commits diferentes quando houver processamento concorrente.

Exemplos no PowerShell:

```powershell
Invoke-RestMethod 'http://localhost:3000/api/wallets/0192f291-27dd-7d3f-8071-5f8685deef37'
Invoke-RestMethod 'http://localhost:3000/api/wagering/transactions/0192f298-345e-7e38-af88-e43f851a819d'
Invoke-RestMethod 'http://localhost:3000/api/providers/provider-a/wagering/transactions/transaction-123'
```

Os testes em `test/integration/http-queries.spec.ts` iniciam uma API temporária em porta aleatória contra `TEST_DATABASE_URL`. Eles verificam as rotas reais, ausência de escrita durante GETs, saldo atual versus saldo observado, isolamento por provedor, erros `400`/`404` e leitura de rejeições. Veja o setup em [test/integration/README.md](../test/integration/README.md).
