# Publicação (deploy)

## Resumo da arquitetura

O BemRecibo tem duas partes: uma **interface estática** (HTML/CSS/JS) e uma **API
Python** (FastAPI + ReportLab + SQLite). O Cloudflare Pages publica muito bem a
interface, mas **não executa Python/FastAPI, não mantém SQLite em disco e não roda
ReportLab**. Por isso existem dois caminhos:

| Opção | O que é publicado no Cloudflare | Onde roda a API | Esforço | Custo |
| --- | --- | --- | --- | --- |
| **A — recomendada** | Interface (Pages) | Host Python (Render/Fly/Railway) | Baixo, sem reescrever código | Grátis (com limitações) |
| **B — 100% Cloudflare** | Interface + API (Workers) | Cloudflare Workers + D1 | Alto, reescrever a API em TypeScript e o PDF | Grátis |
| **C — Containers** | Interface (Pages) | Cloudflare Containers (Docker) | Médio | Plano pago |

---

## Opção A — Cloudflare Pages + API Python

### 1. Publicar a API

**Render (mais simples).** No painel do Render: *New → Blueprint*, aponte para o
repositório e ele lê o [`render.yaml`](../render.yaml). O serviço sobe em
`https://bemrecibo-api.onrender.com`.

Alternativa com Docker (Fly.io, Railway, Koyeb):

```bash
docker build -t bemrecibo .
docker run -p 8000:8000 -e ALLOWED_ORIGINS='*' bemrecibo
```

Confira:

```bash
curl https://SUA-API/health          # {"status":"ok"}
curl https://SUA-API/institution     # dados da instituição
```

> **Atenção ao SQLite em planos gratuitos:** o disco é efêmero, então o banco pode
> ser recriado a cada deploy/restart. Para o MVP acadêmico isso é aceitável; em
> produção use Postgres (`pip install "psycopg[binary]"` e defina `DATABASE_URL`)
> ou um disco persistente no Plano Starter.

### 2. Apontar a interface para a API

Em `frontend/index.html`, informe a URL da API:

```html
<meta name="bemrecibo-api" content="https://bemrecibo-api.onrender.com">
```

Sem essa meta tag a interface assume **mesma origem** (funciona quando o próprio
FastAPI serve `/app`).

### 3. Publicar a interface no Cloudflare Pages

**Via Git (recomendado):** Cloudflare Dashboard → *Workers & Pages → Create →
Pages → Connect to Git*:

- Framework preset: **None**
- Build command: *(vazio)*
- Build output directory: **frontend**
- Root directory: *(raiz do repositório)*

**Via linha de comando:**

```bash
npx wrangler login
npx wrangler pages project create bemrecibo --production-branch main
npx wrangler pages deploy          # lê wrangler.toml na raiz
```

O arquivo `frontend/_headers` aplica cabeçalhos de segurança automaticamente.

### 4. Liberar o CORS na API

Defina a variável de ambiente da API com a URL do Pages:

```
ALLOWED_ORIGINS=https://bemrecibo.pages.dev,https://SEU-DOMINIO.org.br
```

O padrão `*` funciona, mas restringir a origem é o correto em produção.

### 5. Domínio próprio (opcional)

No Pages: *Custom domains → Set up a domain*. Se a API também tiver domínio
próprio (ex.: `api.institutopelobem.org.br`), atualize a meta tag e o CORS.

---

## Opção B — 100% Cloudflare (Workers + D1)

Para eliminar o servidor Python seria necessário:

1. Reescrever as rotas em TypeScript com Hono (ou Workers nativo), mantendo o
   mesmo contrato JSON — a interface atual continuaria funcionando sem alteração.
2. Migrar o banco para **D1** (SQLite gerenciado), incluindo a numeração
   sequencial por exercício.
3. Substituir o ReportLab por **pdf-lib** no Worker (ou gerar o PDF no navegador
   com jsPDF a partir do JSON da API).
4. Reimplementar valor por extenso, máscaras e o layout do PDF.

Vantagens: hospedagem gratuita, sem cold start de 30 s do Render free, banco
gerenciado com backup. Desvantagens: dois backends para manter ou descarte do
backend Python usado na disciplina.

**Esse caminho é uma decisão de projeto** — não é uma migração automática.

## Opção C — Cloudflare Containers

O Cloudflare Containers roda a imagem Docker deste repositório sem alterar código,
mas exige plano pago e o banco continua precisando de armazenamento externo
(D1/Postgres). Vale quando já existe assinatura Cloudflare.

---

## Checklist pós-deploy

- [ ] `GET /health` responde `{"status":"ok"}`
- [ ] A interface abre e o rodapé mostra "API conectada"
- [ ] Cadastro de doador funciona e aparece na lista
- [ ] Doação financeira gera PDF com "valor por extenso" correto
- [ ] Doação de bem gera "Termo de Doação e Entrega"
- [ ] Upload de comprovante habilita a instituição e remove a advertência para PJ
- [ ] Exportação CSV abre no Excel com acentuação correta
- [ ] `ALLOWED_ORIGINS` restrito ao domínio publicado

## Backup e operação

```bash
# backup do SQLite (enquanto estiver nesse modelo)
sqlite3 backend/bemrecibo.db ".backup backup-$(date +%F).db"

# cópia lógica para outro ambiente
python -c "import sqlite3; sqlite3.connect('backend/bemrecibo.db').backup(sqlite3.connect('copia.db'))"
```

Recomenda-se backup diário do banco e retenção mínima de 5 anos dos documentos
emitidos, conforme práticas contábeis do terceiro setor.
