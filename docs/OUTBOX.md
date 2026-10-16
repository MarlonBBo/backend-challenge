# Publicador da outbox

O publicador inicia junto com a aplicação. A operação financeira grava os eventos na tabela `outbox_messages` dentro do mesmo commit de wallet, transação, ledger e inbox. O publicador lê apenas registros confirmados e envia os envelopes persistidos para `SQS_EVENTS_QUEUE_URL` (`wager-events.fifo` no Compose).

## Lotes e concorrência

Cada ciclo usa uma nova Unit of Work e seleciona até 25 eventos com `published_at is null` e `next_attempt_at` vencido ou ausente. A consulta ordena por `occurred_at` e `id` e usa `FOR UPDATE SKIP LOCKED` (`LockMode.PESSIMISTIC_PARTIAL_WRITE` no MikroORM). Os locks permanecem durante o envio e a atualização dos registros, até o commit do lote. Outro publicador ignora esses registros e publica eventos disponíveis em outro lote.

Essa estratégia dispensa uma tabela de leases: se o processo morrer, o PostgreSQL desfaz a transação e libera os locks. Os eventos não confirmados permanecem disponíveis. O custo é manter uma conexão e uma transação abertas durante chamadas ao SQS; o lote é limitado a 100 eventos e cada envio tem timeout de 10 segundos, incluindo as tentativas do SDK. O padrão é de 25 eventos por ciclo.

## Identidade e entrega at-least-once

O corpo enviado é o envelope armazenado na outbox. O publicador não recria `eventId`, `occurredAt`, correlação nem payload. O SQS recebe `MessageDeduplicationId=eventId` e `MessageGroupId=aggregateId`.

Após o SQS aceitar o evento, o publicador preenche `published_at` e limpa `next_attempt_at`. O lote é confirmado no PostgreSQL ao final. Uma falha no banco desfaz as atualizações do lote, inclusive as dos eventos que já chegaram ao SQS.

Se ocorrer falha após o envio e antes do commit, uma nova instância reenviará o mesmo evento. A deduplicação FIFO suprime repetições dentro de sua janela de cinco minutos, mas consumidores de eventos precisam deduplicar persistentemente por `eventId` para repetições posteriores. Não há transação distribuída entre PostgreSQL e SQS, portanto a garantia é at-least-once. Publicadores concorrentes também não garantem a ordem de origem dos eventos de um mesmo agregado; o agrupamento FIFO ordena a chegada ao SQS.

## Falhas, backoff e encerramento

Uma falha de envio mantém o evento pendente, incrementa `attempts` e agenda retry em 1, 2, 4, 8 segundos, até o teto de 5 minutos. `attempts` conta falhas de envio persistidas; o primeiro envio bem-sucedido mantém o valor zero. O restante do lote pode continuar. O backoff usa a data após a falha, evitando reagendar no passado quando o envio demora.

Falhas de persistência interrompem o lote e causam rollback; elas não são convertidas em falhas de envio dentro da mesma transação. Não há descarte por limite de tentativas na outbox: eventos financeiros confirmados devem continuar disponíveis até serem publicados. Um evento problemático fica visível nas medições de pendência, falhas e atraso, enquanto outros eventos podem avançar.

O próximo ciclo começa somente após o anterior terminar. Durante shutdown, o worker cancela o timer, conclui o envio em andamento, para antes do próximo evento e aguarda o commit antes de fechar o cliente SQS. Em encerramento forçado, o rollback permite recuperação por outra instância.

## Configuração e medições

```dotenv
OUTBOX_WORKER_ENABLED=true
OUTBOX_WORKER_INTERVAL_MS=1000
OUTBOX_WORKER_BATCH_SIZE=25
```

Os valores são validados por ambiente e repassados pelo Compose. `OUTBOX_WORKER_ENABLED=false` permite executar somente a API e os demais workers.

O worker mantém contadores em memória de tentativas, sucessos e falhas de envio de lotes confirmados, além de falhas de lote. A propriedade `metrics` devolve uma cópia desses contadores. As medições `pending` e `oldestPendingAgeMs` consultam todas as pendências no banco, incluindo eventos aguardando backoff. Lotes com trabalho ou pendências registram essas medições e, por evento tentado, `eventId`, falhas acumuladas e atraso desde `occurredAt`. Contadores em memória reiniciam com o processo e não incluem envios de transações revertidas; o histórico de falhas persistidas permanece no banco. O endpoint `GET /metrics` expõe, entre outras séries, `outbox_published_total`, `outbox_pending_messages`, `outbox_lag_seconds` e retries por worker. Não há agregação entre processos ou dashboard configurado.

## Testes reais

Crie um banco exclusivo para o publicador. Ele não pode compartilhar pendências com a aplicação ou com a suíte de referências:

```sh
docker compose exec postgres psql -U wagering -d postgres -c 'CREATE DATABASE wagering_outbox_test;'
```

Configuração em Bash (Linux/macOS/WSL):

```bash
export TEST_OUTBOX_DATABASE_URL='postgresql://wagering:wagering@localhost:5432/wagering_outbox_test'
export TEST_SQS_ENDPOINT='http://localhost:4566'
bun run test:integration
```

Configuração em PowerShell:

```powershell
$env:TEST_OUTBOX_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering_outbox_test'
$env:TEST_SQS_ENDPOINT = 'http://localhost:4566'
& "$env:USERPROFILE\.bun\bin\bun.exe" run test:integration
```

Use o IP da WSL no lugar de `localhost` se necessário. Sem as duas variáveis, os testes de publicação são ignorados. A suíte aplica migrations, cria e remove sua própria fila FIFO e preserva registros do banco. Ela cobre eventos de abertura e BET reais, equivalência de saldo com ledger, invisibilidade antes do commit, retry, dois publicadores, recuperação após envio sem confirmação no banco, métricas e execução automática. Se uma execução interrompida deixar eventos pendentes, use outro banco exclusivo com nome terminado em `_test`.

Para atualizar o container da aplicação:

```sh
docker compose --profile app up -d --build app
```
