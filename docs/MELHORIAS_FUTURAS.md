# Possíveis melhorias futuras

Evoluções propostas, não implementadas nesta entrega. A prioridade inicial é preparar a operação em produção; otimizações devem ser orientadas por medições.

## 1. Preparação para produção

- **Autenticação e autorização:** integrar um IdP externo e limitar o acesso de cada provedor aos recursos autorizados.
- **Segurança operacional:** gerenciar segredos, configurar TLS e restringir acesso ao banco, filas e métricas.
- **Backups e recuperação:** testar restauração e definir limites aceitáveis de indisponibilidade e perda de dados.
- **Monitoramento e alertas:** acompanhar divergências, DLQ, referências pendentes e atraso da outbox.

## 2. Escala e confiabilidade

- **Testes de carga:** medir throughput, latência e contenção por carteira antes de otimizar.
- **Publisher com leases/claims:** avaliar publicação sem manter uma transação SQL aberta durante chamadas ao SQS, preservando recuperação e entrega at-least-once.
- **Tracing distribuído:** acompanhar operações entre HTTP/SQS, banco e publicação de eventos.
- **Retenção de dados:** planejar arquivamento de inbox/outbox e crescimento do ledger sem perder auditoria ou proteção contra duplicatas.

## 3. Manutenção e operação

- **CI automatizado:** executar lint, build e testes com PostgreSQL/LocalStack a cada alteração.
- **OpenAPI:** publicar contratos e exemplos da API.
- **Reprocessamento da DLQ:** oferecer recuperação controlada, auditável e protegida contra efeitos duplicados.
- **Reconciliação agendada:** detectar divergências automaticamente, sem reparar saldos de forma silenciosa.

## 4. Arquitetura e código

- **Separação das camadas:** concentrar a configuração de dependências do NestJS na composição da aplicação, reduzindo o conhecimento de adapters concretos nos módulos de aplicação.
- **Caso de uso de processamento:** avaliar a extração de políticas por tipo de transação caso as regras cresçam, mantendo explícita a coordenação transacional e evitando abstrações sem necessidade.
- **Contratos dos adapters:** ampliar testes de contrato para garantir que implementações de persistência e mensageria respeitem as mesmas portas e garantias.
- **Tratamento de falhas:** padronizar a tradução de erros de infraestrutura para HTTP e SQS, distinguindo conflitos, falhas transitórias e falhas permanentes sem expor detalhes internos.
- **Proteção das dependências:** automatizar verificações que impeçam o domínio de importar framework, ORM ou infraestrutura.

## 5. Evoluções de negócio

- Ampliar o suporte operacional a outras moedas, definindo escala, validações e regras próprias.
- Avaliar ledger de partidas dobradas caso os requisitos contábeis justifiquem a mudança.

Para uma próxima etapa, priorizar autenticação, alertas, testes de carga e CI. As decisões e limitações atuais estão em [ARCHITECTURE.md](../ARCHITECTURE.md).
