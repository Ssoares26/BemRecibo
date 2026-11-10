# BemRecibo

Sistema web de controle de doações e emissão automática de recibos para o
**Instituto Pelo Bem** (Recife-PE). Projeto acadêmico de Análise e Desenvolvimento
de Sistemas que substitui o processo manual de emissão de recibos por um fluxo
automatizado, rastreável e com travas de conformidade fiscal.

- Cadastro unificado de doadores **PF e PJ** com identificador único (CPF/CNPJ)
- Registro de doações **financeiras** e de **bens/serviços**
- Numeração sequencial automática (`BR-2026-000001`) por exercício
- Emissão de PDF padronizado: recibo PF/PJ, declaração pós-habilitação e termo de doação e entrega
- **Trava de habilitação fiscal**: só emite documento sem advertência após anexo do comprovante legal
- Consulta com filtros, reemissão de documentos, cancelamento com trilha de auditoria e exportação CSV
- Painel com indicadores de arrecadação

## Stack

| Camada | Tecnologia |
| --- | --- |
| API | Python 3.11 · FastAPI · SQLAlchemy 2 · Pydantic 2 |
| Banco | SQLite (padrão) — configurável via `DATABASE_URL` |
| Documentos | ReportLab (PDF gerado sob demanda, sem armazenar arquivos) |
| Interface | HTML, CSS e JavaScript puro (sem build, sem dependências) |

## Estrutura

```
BemRecibo/
├── backend/
│   ├── bemrecibo/
│   │   ├── main.py        # rotas HTTP
│   │   ├── models.py      # tabelas SQLAlchemy
│   │   ├── schemas.py     # validação de entrada/saída
│   │   ├── services.py    # PDF, valor por extenso, formatação
│   │   └── database.py    # conexão + migrações leves
│   ├── tests/             # testes automatizados (pytest)
│   ├── schema.sql         # documentação do esquema
│   ├── seed_demo.py       # dados de demonstração
│   └── requirements.txt
├── frontend/              # interface (index.html, styles.css, app.js)
├── deploy/                # configurações de publicação
└── docs/                  # apresentação do projeto (PDF)
```

## Como rodar localmente

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

cd backend
python -m uvicorn bemrecibo.main:app --reload --port 8000
```

Acesse:

- Interface: <http://127.0.0.1:8000/app/> (a raiz `/` redireciona o navegador)
- Documentação da API: <http://127.0.0.1:8000/docs>
- Saúde do serviço: <http://127.0.0.1:8000/health>

O banco `backend/bemrecibo.db` é criado no primeiro start. Para carregar dados de
demonstração:

```bash
cd backend
python seed_demo.py --reset
```

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

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/` | Status da API (JSON) ou redireciona para a interface |
| GET | `/health` | Verificação de saúde |
| GET | `/institution` | Dados e status da instituição |
| PUT | `/institution` | Atualiza dados cadastrais usados no PDF |
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
pip install -r backend/requirements-dev.txt
cd backend && python -m pytest -q
```

## Configuração

| Variável | Padrão | Uso |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///backend/bemrecibo.db` | String de conexão SQLAlchemy |
| `ALLOWED_ORIGINS` | `*` | Origens permitidas no CORS (lista separada por vírgula) |

Na interface, a URL da API é definida pela meta tag `bemrecibo-api` em
`frontend/index.html`. Vazia = mesma origem (quando o FastAPI serve o frontend).

## Deploy

Ver [`deploy/README.md`](deploy/README.md) para o passo a passo de publicação
(Cloudflare Pages para a interface + hospedagem da API) e [`render.yaml`](render.yaml)
para o blueprint do backend.

## Limitações conhecidas (escopo acadêmico)

- Autenticação de usuários e perfis de acesso ainda não implementadas
- Comprovante legal armazenado em base64 na própria tabela (adequado ao MVP;
  em produção usar object storage)
- Textos fiscais são demonstrativos e dependem de validação contábil/jurídica
- LGPD: dados pessoais de doadores devem seguir política de retenção e consentimento

## Equipe

Andrea Queiroz · Arthur Cabral · André Soares · Bruno Henrique · João Prysthon ·
Júlio Rodrigues · Natália Almeida · Nayara Gabrielle · Rebeka Natália · Samuel Santana
