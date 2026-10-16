# Distributed Wagering Processor

Processador financeiro de apostas com Bun, NestJS, PostgreSQL, SQS, inbox/outbox e ledger imutável. Valores monetários são strings decimais; a operação pública usa BRL.

- [Arquitetura, decisões e limitações](ARCHITECTURE.md)
- [Possíveis melhorias futuras](docs/MELHORIAS_FUTURAS.md)
- [Enunciado original do desafio](docs/DESAFIO.md)
- [Demonstração manual — Bash e PowerShell](docs/DEMONSTRACAO.md)
- [Testes e bancos isolados](test/integration/README.md)

## Executar com Docker (caminho principal)

Pré-requisitos: Git, Docker Engine/Docker Desktop com Compose v2 e portas 3000, 5432 e 4566 disponíveis. Execute os comandos na raiz deste repositório, no terminal que acessa seu daemon Docker. No Windows, isso pode ser PowerShell com Docker Desktop ou uma distribuição WSL com Docker instalado; WSL não é requisito para os demais sistemas.

Não é necessário instalar Bun no host nem criar .env para este caminho: o Compose define as variáveis da aplicação com endereços internos postgres/localstack.

```sh
docker compose up -d postgres localstack
docker compose ps
docker compose --profile app build app
docker compose --profile app run --rm app bun run db:migration:up
docker compose --profile app up -d app
docker compose --profile app ps
```

O primeiro download/build pode demorar. PostgreSQL e LocalStack devem ficar healthy. A migration precisa terminar com sucesso **antes** de iniciar a aplicação; não é aplicada automaticamente no startup. A API fica em http://localhost:3000/api.

Verifique a prontidão:

Bash (Linux, macOS ou WSL):

```bash
curl --fail --show-error http://localhost:3000/health/ready
```

PowerShell:

```powershell
Invoke-RestMethod 'http://localhost:3000/health/ready'
```

Esperado: status ok e checks database/sqs up.

Logs e encerramento (qualquer shell):

```sh
docker compose --profile app logs --tail 100 app
docker compose --profile app down
```

O encerramento sem a opção de volumes preserva o volume PostgreSQL. Não use a opção de remoção de volumes para resolver erros de senha: ela apaga dados. LocalStack não tem volume persistente neste Compose; recriá-lo pode perder filas/mensagens locais.

## Executar Bun no host (alternativa)

Pré-requisitos adicionais: Bun 1.x no PATH (versão usada: 1.4.3). Este modo é útil para desenvolvimento e execução dos testes; Docker ainda fornece PostgreSQL e LocalStack. Não execute a API do host e a do Compose na mesma porta.

Inicie a infraestrutura:

```sh
docker compose up -d postgres localstack
```

Crie .env apenas se ainda não existir, sem sobrescrever suas configurações:

Bash:

```bash
test -f .env || cp .env.example .env
```

PowerShell:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Edite .env: localhost é o endereço padrão para serviços publicados pelo Docker no mesmo host. Se Bun estiver no Windows e Docker em outra rede WSL, talvez seja necessário usar o IP da WSL em DATABASE_URL, SQS_ENDPOINT e nas três URLs SQS. Não use os nomes internos postgres/localstack em uma aplicação executada no host.

Com Bun no PATH, os comandos abaixo são iguais nos dois shells:

```sh
bun install --frozen-lockfile
bun --env-file=.env run db:migration:up
bun run build
bun --env-file=.env run start:prod
```

O carregamento explícito do .env também entrega as variáveis à CLI de migration executada pelo Node. Usamos build seguido de start:prod para os metadados de decorators emitidos pelo TypeScript. Deixe o terminal da API aberto e use outro terminal para as requisições.

No PowerShell, caso Bun não esteja no PATH:

```powershell
$bun = "$env:USERPROFILE\.bun\bin\bun.exe"
& $bun install --frozen-lockfile
& $bun --env-file=.env run db:migration:up
& $bun run build
& $bun --env-file=.env run start:prod
```

Não envie .env ao Git. Credenciais de exemplo são apenas para uso local. Comandos de rollback podem apagar tabelas: nunca use db:migration:down em dados que deseja preservar. O script db:schema:validate apenas imprime SQL de recriação; não comprova ausência de drift.

## API e operação

| Método | Caminho                                                                 | Uso                                        |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------ |
| POST   | /api/wallets                                                            | Criar wallet com playerId e initialBalance |
| GET    | /api/wallets/:walletId                                                  | Consultar saldo atual                      |
| POST   | /api/wagering/transactions                                              | Processar operação; exige Idempotency-Key  |
| GET    | /api/wagering/transactions/:transactionId                               | Consultar resultado persistido             |
| GET    | /api/providers/:providerId/wagering/transactions/:externalTransactionId | Consultar por identidade externa           |
| GET    | /api/wallets/:walletId/ledger                                           | Extrato paginado por cursor                |
| POST   | /api/wallets/:walletId/reconciliation                                   | Comparar saldo e ledger, sem reparo        |
| GET    | /health/live                                                            | Processo vivo                              |
| GET    | /health/ready                                                           | PostgreSQL e três filas SQS acessíveis     |
| GET    | /metrics                                                                | Métricas Prometheus por processo           |

Contratos detalhados: [consultas](docs/QUERIES.md), [ledger](docs/LEDGER.md), [SQS](docs/SQS.md) e [outbox](docs/OUTBOX.md). HTTP aceita e devolve x-correlation-id. Dinheiro sempre usa strings com duas casas, por exemplo "25.00", nunca números JSON.

A reconciliação retorna storedBalance, calculatedBalance, difference (persistido menos calculado), consistent, contagens e checkedAt. Divergências geram log/métrica, não correção.

**Não há autenticação real:** ProviderAuthGuard é no-op. Mantenha a API, métricas e serviços em rede confiável; o Compose publica portas e não é uma configuração segura de produção. A decisão e o desenho de evolução estão na arquitetura.

## Testes

Com Bun instalado no host:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
```

Para integração e processos reais, siga o [guia de testes](test/integration/README.md), com os cinco bancos exclusivos e variáveis em Bash ou PowerShell.

**Sem as variáveis correspondentes, os testes de integração/distribuídos são ignorados.** Um resultado sem falhas mas com cenários ignorados não comprova essas garantias. Use test:distributed ou compile antes de rodar a suíte completa, pois os processos filhos executam dist.

Última validação registrada: 199 unitários, 36 de integração e 6 distribuídos, total de 241 testes sem falhas; lint, typecheck, formatação, build, imagem Docker, migration no container e readiness aprovados. Referência de 16/10/2026, não uma execução automática a cada alteração.

## Demonstração e plataformas

O [roteiro manual](docs/DEMONSTRACAO.md) cria dados novos e verifica abertura, BET, replay, REFUND e reconciliação, com resultados esperados. Não substitui testes concorrentes ou de recuperação.

Os exemplos estão separados por shell, não por uma dependência de WSL: Bash para Linux/macOS/WSL e PowerShell para Windows (ou onde estiver instalado). A validação registrada ocorreu em Windows com Bun e Docker na WSL Ubuntu, incluindo execução Linux em container. Execução nativa em Linux/macOS não foi validada separadamente; as instruções para esses ambientes não representam certificação.
