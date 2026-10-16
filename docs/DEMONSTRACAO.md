# Demonstração manual da API

Inicie a aplicação conforme o [README](../README.md). Execute os blocos em ordem, no mesmo terminal, para manter as variáveis. O roteiro cria dados novos; não remove fixtures nem altera registros existentes diretamente no banco. Não repita os blocos de criação com as mesmas identidades se quiser uma nova demonstração: reinicie pelo bloco de variáveis.

Escolha **um** dos shells abaixo. Se usar outra porta/endereço, ajuste BASE ou $base. Mantenha a API em outro terminal, ou em container.

## Bash — Linux/macOS/WSL

Ferramentas adicionais para este roteiro: curl, jq (leitura/criação de JSON) e uuidgen (identificadores). São utilitários da demonstração, não dependências da aplicação. Se algum estiver ausente, disponibilize-o no host ou use o roteiro PowerShell.

### 1. Preparar e verificar saúde

```bash
BASE='http://localhost:3000'
PLAYER_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
BET_EXTERNAL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
BET_KEY=$(uuidgen | tr '[:upper:]' '[:lower:]')
REFUND_KEY=$(uuidgen | tr '[:upper:]' '[:lower:]')
REFUND_EXTERNAL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

curl --fail --silent --show-error "$BASE/health/live" | jq
curl --fail --silent --show-error "$BASE/health/ready" | jq
```

Esperado: live ok e ready ok, com database/sqs up. Pare e resolva a infraestrutura se readiness falhar.

### 2. Criar carteira com 100.00

```bash
WALLET_BODY=$(jq -n --arg player "$PLAYER_ID"   '{playerId:$player,initialBalance:{amount:"100.00",currency:"BRL"}}')
WALLET=$(curl --fail --silent --show-error "$BASE/api/wallets"   -H 'Content-Type: application/json' -d "$WALLET_BODY")
printf '%s\n' "$WALLET" | jq
WALLET_ID=$(printf '%s' "$WALLET" | jq -er '.id')
```

Esperado: HTTP 201 e balance.amount "100.00". Se o comando falhar ou não houver id, não prossiga.

### 3. Apostar 25.00

```bash
BET_BODY=$(jq -n --arg player "$PLAYER_ID" --arg wallet "$WALLET_ID"   --arg external "$BET_EXTERNAL_ID"   '{providerId:"demo",externalTransactionId:$external,playerId:$player,walletId:$wallet,roundId:"round-demo",gameId:"game-demo",kind:"BET",money:{amount:"25.00",currency:"BRL"}}')

BET=$(curl --fail --silent --show-error "$BASE/api/wagering/transactions"   -H 'Content-Type: application/json' -H "Idempotency-Key: $BET_KEY"   -H 'x-correlation-id: demo-manual' -d "$BET_BODY")
printf '%s\n' "$BET" | jq
TRANSACTION_ID=$(printf '%s' "$BET" | jq -er '.transactionId')
```

Esperado: HTTP 201, PROCESSED, saldo "75.00" e idempotentReplay false.

### 4. Repetir sem alterar corpo nem chave

```bash
curl --fail --silent --show-error "$BASE/api/wagering/transactions"   -H 'Content-Type: application/json' -H "Idempotency-Key: $BET_KEY"   -H 'x-correlation-id: demo-manual' -d "$BET_BODY" | jq
```

Esperado: HTTP 200, mesmo transactionId, saldo "75.00" e idempotentReplay true. Não gere outra chave neste passo.

### 5. Consultar saldo, resultado e ledger

```bash
curl --fail --silent --show-error "$BASE/api/wallets/$WALLET_ID" | jq
curl --fail --silent --show-error "$BASE/api/wagering/transactions/$TRANSACTION_ID" | jq
curl --fail --silent --show-error "$BASE/api/wallets/$WALLET_ID/ledger" | jq
```

Esperado: saldo atual "75.00"; ledger com OPENING CREDIT de "100.00" e BET DEBIT de "25.00", sem segundo débito.

### 6. Estornar a aposta

```bash
REFUND_BODY=$(jq -n --arg player "$PLAYER_ID" --arg wallet "$WALLET_ID"   --arg external "$REFUND_EXTERNAL_ID" --arg reference "$BET_EXTERNAL_ID"   '{providerId:"demo",externalTransactionId:$external,playerId:$player,walletId:$wallet,roundId:"round-demo",gameId:"game-demo",kind:"REFUND",referenceExternalTransactionId:$reference,money:{amount:"25.00",currency:"BRL"}}')

curl --fail --silent --show-error "$BASE/api/wagering/transactions"   -H 'Content-Type: application/json' -H "Idempotency-Key: $REFUND_KEY"   -H 'x-correlation-id: demo-manual' -d "$REFUND_BODY" | jq
```

Esperado: HTTP 201, PROCESSED e saldo "100.00". O REFUND usa nova chave e nova identidade externa, mas referencia a identidade externa da BET original.

### 7. Reconciliar e consultar métricas

```bash
curl --fail --silent --show-error -X POST "$BASE/api/wallets/$WALLET_ID/reconciliation" | jq
curl --fail --silent --show-error "$BASE/api/wallets/$WALLET_ID/ledger" | jq
curl --fail --silent --show-error "$BASE/metrics"
```

## PowerShell — Windows ou outro sistema com PowerShell instalado

Não exige jq/uuidgen. O roteiro usa Invoke-RestMethod e geração de GUID nativos do PowerShell.

### 1. Preparar e verificar saúde

```powershell
$base = 'http://localhost:3000'
$playerId = [guid]::NewGuid().ToString()
$betExternalId = [guid]::NewGuid().ToString()
$betHeaders = @{
    'Idempotency-Key' = [guid]::NewGuid().ToString()
    'x-correlation-id' = 'demo-manual'
}
$refundHeaders = @{
    'Idempotency-Key' = [guid]::NewGuid().ToString()
    'x-correlation-id' = 'demo-manual'
}

Invoke-RestMethod "$base/health/live"
Invoke-RestMethod "$base/health/ready" | ConvertTo-Json -Depth 5
```

Esperado: live ok e ready ok, com database/sqs up. Se ocorrer erro, pare antes dos próximos blocos.

### 2. Criar carteira com 100.00

```powershell
$walletBody = @{
    playerId = $playerId
    initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5

$wallet = Invoke-RestMethod "$base/api/wallets" -Method Post -ContentType 'application/json' -Body $walletBody
$wallet | ConvertTo-Json -Depth 5
```

Esperado: HTTP 201 e balance.amount "100.00".

### 3. Apostar 25.00

```powershell
$betBody = @{
    providerId = 'demo'
    externalTransactionId = $betExternalId
    playerId = $playerId
    walletId = $wallet.id
    roundId = 'round-demo'
    gameId = 'game-demo'
    kind = 'BET'
    money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5

$bet = Invoke-RestMethod "$base/api/wagering/transactions" -Method Post -ContentType 'application/json' -Headers $betHeaders -Body $betBody
$bet | ConvertTo-Json -Depth 5
```

Esperado: HTTP 201, PROCESSED, saldo "75.00" e idempotentReplay false.

### 4. Repetir sem alterar corpo nem chave

```powershell
$replay = Invoke-RestMethod "$base/api/wagering/transactions" -Method Post -ContentType 'application/json' -Headers $betHeaders -Body $betBody
$replay | ConvertTo-Json -Depth 5
```

Esperado: HTTP 200, mesmo transactionId e saldo, com idempotentReplay true.

### 5. Consultar saldo, resultado e ledger

```powershell
Invoke-RestMethod "$base/api/wallets/$($wallet.id)" | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/api/wagering/transactions/$($bet.transactionId)" | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/api/wallets/$($wallet.id)/ledger" | ConvertTo-Json -Depth 10
```

Esperado: saldo "75.00"; ledger com crédito de abertura "100.00" e um único débito "25.00".

### 6. Estornar a aposta

```powershell
$refundBody = @{
    providerId = 'demo'
    externalTransactionId = [guid]::NewGuid().ToString()
    playerId = $playerId
    walletId = $wallet.id
    roundId = 'round-demo'
    gameId = 'game-demo'
    kind = 'REFUND'
    referenceExternalTransactionId = $betExternalId
    money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod "$base/api/wagering/transactions" -Method Post -ContentType 'application/json' -Headers $refundHeaders -Body $refundBody | ConvertTo-Json -Depth 5
```

Esperado: HTTP 201, PROCESSED e saldo "100.00".

### 7. Reconciliar e consultar métricas

```powershell
Invoke-RestMethod "$base/api/wallets/$($wallet.id)/reconciliation" -Method Post | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/api/wallets/$($wallet.id)/ledger" | ConvertTo-Json -Depth 10
(Invoke-WebRequest "$base/metrics" -UseBasicParsing).Content
```

## Resultado final esperado nos dois roteiros

| Verificação                     | Resultado                                                   |
| ------------------------------- | ----------------------------------------------------------- |
| Saldo persistido e reconstruído | Ambos "100.00" BRL                                          |
| difference.amount               | "0.00"                                                      |
| consistent                      | true                                                        |
| checkedEntries                  | 3                                                           |
| Ledger                          | OPENING CREDIT 100.00, BET DEBIT 25.00, REFUND CREDIT 25.00 |
| Replay da BET                   | Mesmo transactionId, sem outro débito                       |

Os movimentos aparecem do mais recente para o mais antigo. A consulta da BET original continua mostrando o saldo observado "75.00", mesmo depois do REFUND; a carteira mostra o saldo atual "100.00". Contadores de métricas são por processo e podem conter outras operações; não espere valores globais exatos em ambiente compartilhado.

Invoke-RestMethod mostra o corpo e lança erro em respostas não-2xx. Curl com --fail também sinaliza essas respostas; se precisar inspecionar headers/status numa requisição, use curl -i sem --fail. Antes de repetir um POST bem-sucedido para inspecioná-lo, lembre-se de que isso é uma nova chamada: mantenha a mesma chave/corpo quando quiser replay.

Este roteiro verifica o fluxo HTTP e seus efeitos persistidos. Não comprova sozinho concorrência, consumo SQS ou morte/recuperação de processos: esses cenários estão na [suíte automatizada](../test/integration/README.md).
