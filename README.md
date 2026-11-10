# BemRecibo

Sistema web de controle de doações e emissão automática de recibos para o
**Instituto Pelo Bem** (Recife-PE). Projeto acadêmico de Análise e Desenvolvimento
de Sistemas que substitui o processo manual de emissão de recibos por um fluxo
automatizado, rastreável e com travas de conformidade fiscal.

O sistema roda **inteiramente no Cloudflare**: a interface, a API e os PDFs são
entregues por um único Worker e os dados ficam no banco D1 (SQLite gerenciado).
Não há servidor para administrar, container para subir nem outro provedor
envolvido.

## Funcionalidades

- Cadastro unificado de doadores **PF e PJ** com identificador único (CPF/CNPJ)
- Registro de doações **financeiras** e de **bens/serviços**
- Numeração sequencial automática (`BR-2026-000001`) por exercício
- Emissão de PDF padronizado: recibo PF/PJ, declaração pós-habilitação e termo de doação e entrega
- **Identidade visual**: logo da instituição, assinatura digitalizada, nome/cargo do responsável e código de verificação do documento
- **Trava de habilitação fiscal**: só emite documento sem advertência após anexo do comprovante legal
- Consulta com filtros, reemissão de documentos, cancelamento com trilha de auditoria e exportação CSV
- Painel com indicadores de arrecadação

## Stack

| Camada | Tecnologia |
| --- | --- |
| API | Cloudflare Workers · TypeScript |
| Banco | Cloudflare D1 (SQLite gerenciado), com migrações versionadas |
| Documentos | `pdf-lib` (PDF gerado sob demanda no Worker, sem armazenar arquivos) |
| Interface | HTML, CSS e JavaScript puro, servida pelo próprio Worker (binding de assets) |

Uma única URL entrega aplicação e API, então não há CORS nem configuração de
endereço da API no front-end.

## Estrutura

```
BemRecibo/
├── cloudflare/            # aplicação publicada (Worker + D1 + assets)
│   ├── src/
│   │   ├── index.ts       # rotas HTTP, validação e regras de numeração
│   │   ├── services.ts    # formatação, valor por extenso, CSV, uploads
│   │   ├── pdf.ts         # geração dos documentos em pdf-lib
│   │   └── types.ts       # tipos das tabelas e do ambiente
│   ├── migrations/        # esquema do banco D1 (0001_init.sql)
│   ├── scripts/           # exportação dos dados e smoke test
│   ├── tests/             # testes do núcleo (npm test)
│   ├── seed.sql           # dados migrados do banco atual
│   └── README.md          # passo a passo de publicação
├── frontend/              # interface (index.html, styles.css, app.js)
├── backend/               # versão Python/FastAPI mantida como referência
└── docs/                  # apresentação do projeto (PDF)
```

## Rodando localmente

Pré-requisitos: Node.js 20 ou superior.

```bash
cd cloudflare
npm install

# na primeira vez: cria o banco local e carrega os dados
npm run db:migrate:local
npm run db:seed:local

npm run dev
```

Acesse <http://127.0.0.1:8787>. A interface e a API saem do mesmo endereço, com
banco D1 simulado em `.wrangler/`.

Para conferir sem abrir o navegador:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/stats
npm run smoke          # bateria de verificação das rotas principais
```

## Deploy

O passo a passo completo (criar o banco D1, aplicar o esquema, carregar os dados
e publicar) está em **[`cloudflare/README.md`](cloudflare/README.md)**.

Na primeira publicação, um comando resolve tudo:

```bash
cd cloudflare
bash scripts/setup.sh
```

Ele confere o login, cria o banco D1, grava o `database_id` no `wrangler.toml`,
aplica o esquema, carrega os dados e publica. Depois disso, novas versões saem com
`npm run deploy`.

> Importante: a aplicação é um **Worker** (com assets), não um projeto **Pages**.
> No painel do Cloudflare use *Workers & Pages → Create → Workers*.

## Migração dos dados

O arquivo `cloudflare/seed.sql` foi gerado a partir do banco SQLite que já
estava em uso (`backend/bemrecibo.db`), preservando doadores, doações,
documentos e os dados da instituição. Para reexportar depois de qualquer
alteração no banco antigo:

```bash
python3 cloudflare/scripts/export-sqlite-to-d1.py   # regenera cloudflare/seed.sql
cd cloudflare && npm run db:seed
```

O script normaliza datas para o padrão ISO e usa `INSERT OR REPLACE`, então pode
ser executado mais de uma vez sem duplicar registros.

## Como a automação decide o documento

| Doador | Status da instituição | Documento | Advertência fiscal |
| --- | --- | --- | --- |
| Pessoa Física | Pré-habilitação | Recibo de Doação PF | Sim |
| Pessoa Física | Habilitada | Recibo de Doação PF | Não |
| Pessoa Jurídica | Pré-habilitação | Recibo de Doação PJ | Sim |
| Pessoa Jurídica | Habilitada | Declaração de Doação Pós-Habilitação | Não |
| Bem / Serviço | Qualquer | Termo de Doação e Entrega | Conforme status |

O status da instituição é congelado em `institution_status_snapshot` no momento do
registro. Reemitir um documento nunca cria uma nova doação nem reaplica regras.

## API

Todas as rotas são servidas pelo Worker na raiz do domínio.

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/` | Interface (navegador) ou status da API (JSON) |
| GET | `/health` | Verificação de saúde |
| GET | `/institution` | Dados e status da instituição |
| PUT | `/institution` | Atualiza dados cadastrais e assinante usados no PDF |
| PUT/DELETE/GET | `/institution/logo` | Envia, remove ou visualiza o logotipo (PNG/JPEG, até 700 KB) |
| PUT/DELETE/GET | `/institution/signature` | Envia, remove ou visualiza a assinatura digitalizada |
| PUT | `/institution/status?status=habilitada` | Habilita (exige `proof`) ou volta para pré-habilitação |
| GET | `/institution/proof` | Baixa o comprovante anexado |
| POST/GET | `/donors` | Cadastro e listagem de doadores (`search`, `person_type`) |
| GET | `/donors/{id}` | Ficha do doador com total doado e histórico |
| POST | `/donations` | Registra doação e gera o documento |
| GET | `/donations` | Lista com filtros (`search`, `date_from`, `date_to`, `donation_type`, `status`) |
| GET | `/donations/{id}` | Detalhe da doação, com valor por extenso |
| DELETE | `/donations/{id}` | Cancela a doação mantendo o registro para auditoria |
| POST | `/donations/{id}/restore` | Reativa uma doação cancelada |
| GET | `/donations/export.csv` | Exporta o resultado dos filtros em CSV |
| GET | `/stats` | Indicadores do painel |
| GET | `/documents/{id}/pdf` | Gera/baixa o PDF (`?inline=true` para abrir no navegador) |

## Testes

```bash
cd cloudflare
npm run typecheck    # TypeScript em modo estrito, sem erros
npm test             # 13 testes do núcleo (valor por extenso, máscaras, PDF, CSV)
```

A versão Python mantém sua própria suíte (50 testes): `cd backend && pytest -q`.

## Configuração

| Item | Onde | Uso |
| --- | --- | --- |
| `DB` | `wrangler.toml` | Binding do banco D1 |
| `ASSETS` | `wrangler.toml` | Binding que serve `frontend/` |
| `ENVIRONMENT` | `wrangler.toml` | Rótulo exibido na interface |
| `bemrecibo-api` | `frontend/index.html` | Opcional: aponta a interface para outra API |

## Limitações conhecidas (escopo acadêmico)

- Autenticação de usuários e perfis de acesso ainda não implementadas
- Comprovante legal, logotipo e assinatura armazenados em base64 na própria
  tabela (adequado ao MVP; em produção usar R2 ou outro object storage)
- Textos fiscais são demonstrativos e dependem de validação contábil/jurídica
- LGPD: dados pessoais de doadores devem seguir política de retenção e consentimento

## Equipe

Andrea Queiroz · Arthur Cabral · André Soares · Bruno Henrique · João Prysthon ·
Júlio Rodrigues · Natália Almeida · Nayara Gabrielle · Rebeka Natália · Samuel Santana
