# Testes de integração e múltiplos processos

Execute os comandos na raiz do projeto. Pré-requisitos: Bun no host, dependências instaladas e Docker Compose com PostgreSQL/LocalStack ativos. Consulte o [README](../../README.md) para setup.

## 1. Preparar bancos exclusivos

No terminal que acessa o Docker, seja Bash ou PowerShell:

```sh
docker compose up -d postgres localstack
docker compose exec postgres createdb -U wagering wagering_reference_test
docker compose exec postgres createdb -U wagering wagering_outbox_test
docker compose exec postgres createdb -U wagering wagering_reconciliation_test
docker compose exec postgres createdb -U wagering wagering_distributed_test
docker compose exec postgres createdb -U wagering wagering_migration_test
```

Crie cada banco apenas uma vez. Se já existir, não é necessário recriá-lo. Não use bancos de desenvolvimento/produção nem execute workers externos sobre os bancos de teste. Os nomes devem terminar em _test; para migration, especificamente _migration_test.

## 2. Configurar o terminal dos testes

As variáveis abaixo valem apenas para a sessão atual. Use o bloco do seu shell.

### Bash — Linux/macOS/WSL

```bash
export TEST_DATABASE_URL='postgresql://wagering:wagering@localhost:5432/wagering_reference_test'
export TEST_OUTBOX_DATABASE_URL='postgresql://wagering:wagering@localhost:5432/wagering_outbox_test'
export TEST_RECONCILIATION_DATABASE_URL='postgresql://wagering:wagering@localhost:5432/wagering_reconciliation_test'
export TEST_DISTRIBUTED_DATABASE_URL='postgresql://wagering:wagering@localhost:5432/wagering_distributed_test'
export TEST_MIGRATION_DATABASE_URL='postgresql://wagering:wagering@localhost:5432/wagering_migration_test'
export TEST_SQS_ENDPOINT='http://localhost:4566'
```

### PowerShell

```powershell
$env:TEST_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering_reference_test'
$env:TEST_OUTBOX_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering_outbox_test'
$env:TEST_RECONCILIATION_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering_reconciliation_test'
$env:TEST_DISTRIBUTED_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering_distributed_test'
$env:TEST_MIGRATION_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering_migration_test'
$env:TEST_SQS_ENDPOINT = 'http://localhost:4566'
```

Se Bun roda no Windows e Docker na rede da WSL, substitua localhost pelo IP acessível da WSL nas cinco URLs e no endpoint SQS. Isso é uma particularidade dessa topologia, não uma exigência do projeto.

## 3. Executar

Com Bun no PATH, os comandos são os mesmos nos dois shells:

```sh
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
bun run test:integration
bun run test:distributed
```

O último comando compila antes de criar os processos filhos. Alternativamente, com todas as variáveis definidas e sem outra execução em andamento:

```sh
bun run build
bun test
```

No PowerShell sem Bun no PATH, substitua cada chamada por:

```powershell
$bun = "$env:USERPROFILE\.bun\bin\bun.exe"
& $bun run test:integration
& $bun run test:distributed
```

**Verifique os cenários ignorados, não apenas as falhas.** Sem a variável de banco, a suíte correspondente é ignorada; cenários SQS também dependem de TEST_SQS_ENDPOINT. A referência registrada em 16/10/2026 é 199 unitários, 36 de integração e 6 distribuídos, com 241 testes e zero falhas na execução conjunta. Contagens podem mudar com a evolução do projeto.

## Cobertura e isolamento

| Variável                                          | Cobertura                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEST_DATABASE_URL                                 | Referências pendentes, locks, rollback, expiração, consultas HTTP e paginação do ledger; com SQS, também inbox, redelivery, consumidor e DLQ                                          |
| TEST_OUTBOX_DATABASE_URL + TEST_SQS_ENDPOINT      | Publicação real, backoff, dois publishers, commit antes do envio e recuperação após envio sem confirmação                                                                             |
| TEST_RECONCILIATION_DATABASE_URL                  | WIN com prêmio diferente, wallet vazia, divergência sem reparo, snapshot durante escrita concorrente e respostas HTTP de health com probes controladas                                |
| TEST_DISTRIBUTED_DATABASE_URL + TEST_SQS_ENDPOINT | Três PIDs reais, 50 duplicatas, disputa de saldo, wallets independentes, referências, SIGKILL após commit/antes de ack e reinício com publicação da outbox; readiness real no startup |
| TEST_MIGRATION_DATABASE_URL                       | Up/down/up em banco vazio; recusa rollback se houver dados ou tabelas inesperadas                                                                                                     |

As migrations são aplicadas pelo setup. Cada cenário usa identificadores novos e preserva suas fixtures financeiras sem remover o ledger. A reconciliação usa outro banco porque uma fixture altera deliberadamente o saldo da wallet para comprovar detecção de divergência, sem repará-lo. Não use esse banco como demonstração de saldos íntegros.

As filas temporárias são exclusivas das suítes e removidas no encerramento; processos filhos e diretórios temporários também são finalizados/removidos. Uma interrupção forçada do próprio test runner pode impedir a limpeza. Execute uma suíte por vez; se sobrarem pendências de uma execução interrompida, use um novo banco vazio com o sufixo exigido, sem apagar dados para contornar o problema.

Os cenários financeiros verificam os efeitos no saldo/ledger; a suíte distribuída reconcilia as wallets criadas antes e depois do reinício. Isso prova os cenários de correção exercitados, não carga, throughput ou disponibilidade de produção.

Contratos e detalhes: [consultas](../../docs/QUERIES.md), [ledger](../../docs/LEDGER.md), [SQS](../../docs/SQS.md), [outbox](../../docs/OUTBOX.md) e [arquitetura](../../ARCHITECTURE.md).
