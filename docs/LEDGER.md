# Consulta paginada do ledger

```http
GET /api/wallets/:walletId/ledger?limit=50&cursor=...
```

A rota retorna somente movimentações da carteira informada, sem alterar saldo, versão, ledger ou eventos. Uma carteira existente sem movimentações retorna `200` com `items: []` e `nextCursor: null`. Carteira inexistente retorna `404 WALLET_NOT_FOUND`; UUID inválido retorna `400 INVALID_PATH_PARAMETER`.

## Resposta

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "items": [
    {
      "id": "0192f298-345e-7e38-af88-e43f851a819d",
      "transactionId": "0192f298-345e-7e38-af88-e43f851a819e",
      "direction": "DEBIT",
      "money": { "amount": "25.00", "currency": "BRL" },
      "balanceBefore": { "amount": "100.00", "currency": "BRL" },
      "balanceAfter": { "amount": "75.00", "currency": "BRL" },
      "createdAt": "2026-10-15T12:00:00.123456Z"
    }
  ],
  "nextCursor": null
}
```

Os valores monetários continuam como strings decimais. `createdAt` é UTC com seis casas fracionárias, preservando os microssegundos do PostgreSQL. Os saldos representam cada movimentação, não o saldo atual da carteira. Operações sem movimentação, como LOSS e rejeições, não possuem entrada no ledger.

## Paginação

`limit` é opcional, com padrão 50 e intervalo de 1 a 100. Deve ser um inteiro decimal canônico: valores como `0`, `101`, `1.5`, `01`, vazios ou parâmetros repetidos retornam `400 INVALID_PAGINATION`.

Os lançamentos são ordenados por `(created_at DESC, id DESC)`. O ID desempata horários iguais; esse desempate dá uma ordem determinística, sem representar necessariamente a ordem financeira entre movimentos de mesmo timestamp. A consulta seguinte usa a condição estrita `(created_at, id) < (timestamp, id)` e o índice existente `wallet_ledger_entries_wallet_cursor_idx`, sem OFFSET.

A consulta busca `limit + 1` registros. Retorna os primeiros `limit` e só gera cursor se o registro adicional existir. O cursor aponta para o último item retornado, não para o registro adicional. Assim, a última página não anuncia uma página vazia extra.

O cursor é um token Base64URL de formato versionado que contém carteira, timestamp exato e ID. O cliente deve tratá-lo como opaco: encaminhe `nextCursor` sem modificá-lo. O token não é uma assinatura criptográfica. A carteira é sempre filtrada separadamente na consulta SQL parametrizada; um cursor vinculado a outra carteira ou com conteúdo inválido retorna `400 INVALID_CURSOR`. Cursores vazios, repetidos ou maiores que 1024 caracteres são rejeitados na validação dos parâmetros.

Não converta o timestamp do cursor para `Date`: JavaScript trunca microssegundos, o que pode fazer lançamentos serem ignorados. A leitura usa uma projeção com timestamp textual obtido diretamente no banco. Não é necessária uma nova migration.

As páginas não formam um snapshot congelado. Movimentações novas que ordenam antes do cursor não deslocam a continuação e aparecem ao reiniciar a consulta. Inserções com data antiga ou timestamps empatados podem aparecer em páginas seguintes se ordenarem depois do cursor; para uma visão atualizada de todo o histórico, reinicie sem cursor. As entradas existentes são imutáveis e o desempate por ID evita repetição ou omissão causada por empates e deslocamentos de OFFSET.

Exemplo com curl e jq (Bash — Linux/macOS/WSL), usando uma carteira existente:

```bash
LEDGER_URL='http://localhost:3000/api/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger'
PAGE=$(curl --fail --silent --show-error --get "$LEDGER_URL" --data-urlencode 'limit=2')
printf '%s\n' "$PAGE" | jq
CURSOR=$(printf '%s' "$PAGE" | jq -r '.nextCursor // empty')
if [ -n "$CURSOR" ]; then
  curl --fail --show-error --get "$LEDGER_URL" --data-urlencode 'limit=2' --data-urlencode "cursor=$CURSOR"
fi
```

O UUID é ilustrativo; substitua pelo ID obtido na [demonstração manual](DEMONSTRACAO.md).

Exemplo no PowerShell:

```powershell
$ledgerPage = Invoke-RestMethod 'http://localhost:3000/api/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger?limit=2'
if ($null -ne $ledgerPage.nextCursor) {
  $ledgerCursor = [Uri]::EscapeDataString($ledgerPage.nextCursor)
  Invoke-RestMethod "http://localhost:3000/api/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger?limit=2&cursor=$ledgerCursor"
}
```

## Verificação

`test/integration/ledger-pagination.spec.ts` usa uma API temporária e PostgreSQL real com fixtures de timestamps iguais e microssegundos diferentes dentro do mesmo milissegundo. Verifica páginas de tamanho 1 e 2, limites, última página, carteira vazia/inexistente, cursor de outra carteira, ausência de escrita durante GET e inserção de um novo movimento entre páginas. No cenário de inserção, também verifica saldo da carteira versus soma do ledger.

O setup usa `TEST_DATABASE_URL`, conforme [test/integration/README.md](../test/integration/README.md). As fixtures são inseridas em transações, com IDs novos, preservando os registros e o trigger de imutabilidade; nenhum UPDATE/DELETE de ledger é usado.
