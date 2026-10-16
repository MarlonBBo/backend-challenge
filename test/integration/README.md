# Testes de integração de referências pendentes

Estes testes usam PostgreSQL real e as migrations da aplicação. Cobrem concorrência entre duas tentativas de worker, referência fora de ordem, rollback por falha na outbox, expiração e execução pelo agendador. Cada cenário verifica que o saldo da carteira equivale à soma do ledger.

Crie um banco exclusivo para testes no PostgreSQL do Compose:

```sh
docker compose up -d postgres
docker compose exec postgres psql -U wagering -d postgres -c 'CREATE DATABASE wagering_reference_test;'
```

No PowerShell:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering_reference_test'
$env:TEST_SQS_ENDPOINT = 'http://localhost:4566'
& "$env:USERPROFILE\.bun\bin\bun.exe" run test:integration
```

Se o PostgreSQL estiver na WSL e `localhost` apontar para outro servidor PostgreSQL do Windows, use o IP retornado por `wsl -d Ubuntu -- hostname -I` no lugar de `localhost`.

O nome do banco precisa terminar em `_test`. Sem `TEST_DATABASE_URL`, os testes de integração são ignorados. A migration é aplicada automaticamente. Cada cenário usa identificadores novos; os registros financeiros de teste são preservados, sem apagar dados ou modificar o ledger.

Com `TEST_SQS_ENDPOINT`, também são executados os testes do consumidor contra LocalStack real (inicie-o com `docker compose up -d localstack`). Eles criam filas FIFO exclusivas e as removem ao final. Cobrem redelivery após commit sem ack, rollback da inbox antes do commit, concorrência pela mesma mensagem, consumo automático e DLQ. Sem essa variável, apenas os cenários SQS são ignorados. Use o IP da WSL também no endpoint quando necessário.

O banco deve ser exclusivo desta suíte, sem uma aplicação/worker externo consumindo suas pendências. Execute uma suíte por vez. Se uma execução for interrompida e deixar pendências, use um novo banco com sufixo `_test` para uma execução isolada.

Os testes do publicador usam outro banco, definido por `TEST_OUTBOX_DATABASE_URL`, além de `TEST_SQS_ENDPOINT`. Isso isola a seleção de eventos dos registros gerados pela suíte de referências. O setup e os cenários estão em [docs/OUTBOX.md](../../docs/OUTBOX.md).
