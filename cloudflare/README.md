# Publicar o BemRecibo no Cloudflare

Guia do deploy completo: **Worker** (API + PDF) + **D1** (banco) + **assets**
(interface). Nada além do Cloudflare é necessário.

Tempo estimado na primeira vez: 15 a 20 minutos.

---

## 0. Antes de começar

| Item | Como obter |
| --- | --- |
| Conta Cloudflare (gratuita) | <https://dash.cloudflare.com/sign-up> |
| Node.js 20+ | <https://nodejs.org> (`node -v` para conferir) |
| Dados atuais | já estão em `seed.sql` (doadores, doações, documentos e instituição) |

O plano gratuito cobre com folga o uso da ONG: 100.000 requisições por dia no
Worker, 5 GB de banco no D1 e 100 MB de arquivos estáticos.

---

## 1. Instalar as dependências

```bash
cd cloudflare
npm install
```

## 2. Autenticar no Cloudflare

```bash
npx wrangler login
```

Abre o navegador, você autoriza e volta ao terminal. Alternativa para servidor
sem navegador: gerar um token em *My Profile → API Tokens → Edit Cloudflare
Workers* e usar

```bash
export CLOUDFLARE_API_TOKEN=seu_token
export CLOUDFLARE_ACCOUNT_ID=seu_account_id
```

## 3. Criar o banco D1

```bash
npx wrangler d1 create bemrecibo
```

A saída traz um bloco assim — copie o `database_id`:

```
[[d1_databases]]
binding = "DB"
database_name = "bemrecibo"
database_id = "a1b2c3d4-0000-1111-2222-333344445555"
```

Abra `cloudflare/wrangler.toml` e substitua o valor de `database_id`
(o atual, `00000000-…`, é só um espaço reservado).

## 4. Criar as tabelas no banco de produção

```bash
npm run db:migrate
```

Isso aplica `migrations/0001_init.sql` (`--remote`) e cria as quatro tabelas
(`institution`, `donors`, `donations`, `documents`) com seus índices.

## 5. Carregar os dados que já existiam

```bash
npm run db:seed
```

Sobe o conteúdo de `seed.sql`: a instituição, os doadores, as doações e os
documentos já emitidos no sistema antigo. Para conferir:

```bash
npx wrangler d1 execute bemrecibo --remote \
  --command "SELECT (SELECT COUNT(*) FROM donors) AS doadores, (SELECT COUNT(*) FROM donations) AS doacoes, (SELECT COUNT(*) FROM documents) AS documentos"
```

> Se preferir começar com o banco vazio, pule este passo.

## 6. Publicar

```bash
npm run deploy
```

A saída mostra o endereço público, por exemplo:

```
https://bemrecibo.SEU-SUBDOMINIO.workers.dev
```

Abra no navegador: a interface carrega e já enxerga o banco D1.

## 7. Ajustes finais dentro do sistema

Na aba **Instituição**:

1. confira CNPJ, endereço, telefone, e-mail e site;
2. envie o **logotipo** (PNG/JPEG, até 700 KB) — aparece no cabeçalho dos PDFs;
3. envie a **assinatura digitalizada** e informe nome e cargo do responsável;
4. se a habilitação fiscal já existir, use **Habilitar instituição** anexando o
   comprovante (PDF ou imagem). Sem esse anexo o sistema continua emitindo
   recibos com a advertência de IRPJ — é a trava de segurança prevista no projeto.

Os arquivos ficam guardados no próprio banco D1, então sobrevivem a novos deploys.

---

## Domínio próprio (opcional)

1. No painel Cloudflare, adicione o domínio da ONG (*Websites → Add a site*) e
   ajuste os nameservers no registrador.
2. Em *Workers & Pages → bemrecibo → Settings → Domains & Routes → Add custom
   domain*, informe por exemplo `recibos.institutopelobem.org.br`.
3. O certificado TLS é emitido automaticamente.

O endereço `*.workers.dev` continua funcionando em paralelo (dá para desligar em
`workers_dev = false` no `wrangler.toml`).

---

## Atualizações do dia a dia

Depois de alterar código:

```bash
cd cloudflare
npm test            # garante que o núcleo continua correto
npm run deploy      # publica a nova versão
```

Outros comandos úteis:

| Comando | Para quê |
| --- | --- |
| `npx wrangler tail` | acompanhar requisições e erros em tempo real |
| `npx wrangler deployments list` | ver versões publicadas |
| `npx wrangler rollback` | voltar para a versão anterior |
| `npx wrangler d1 export bemrecibo --remote --output backup.sql` | backup do banco |

### Backup recomendado

Uma vez por mês (o plano gratuito não faz backup automático):

```bash
npx wrangler d1 export bemrecibo --remote --output backup-$(date +%F).sql
```

Guarde o arquivo fora do repositório.

---

## Publicação automática pelo GitHub (opcional)

O workflow `.github/workflows/deploy-cloudflare.yml` roda os testes e publica a
cada push na `main`. Para ativar, cadastre em
*GitHub → Settings → Secrets and variables → Actions*:

| Secret | Onde encontrar |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | *My Profile → API Tokens → Create Token → Edit Cloudflare Workers* |
| `CLOUDFLARE_ACCOUNT_ID` | *Workers & Pages → Overview*, coluna da direita |

Sem esses secrets o workflow é ignorado e o deploy continua sendo manual.

---

## Se algo der errado

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| `Couldn't find a D1 DB with binding DB` | `database_id` ainda é o de exemplo | refaça o passo 3 |
| `no such table: donations` | migração não aplicada no banco remoto | `npm run db:migrate` |
| Interface abre, mas listas vazias | seed não executado | `npm run db:seed` |
| `Authentication error` no deploy | sessão expirada | `npx wrangler login` novamente |
| PDF sem logo | imagem não enviada ou acima de 700 KB | reenvie em PNG/JPEG menor |
| Erro 500 em uma rota | detalhe no log | `npx wrangler tail` e reproduza a ação |

---

## Estrutura do banco

| Tabela | Conteúdo |
| --- | --- |
| `institution` | dados da ONG, status de habilitação, logo, assinatura, comprovante |
| `donors` | doadores PF/PJ, com CPF/CNPJ único |
| `donations` | doações, número do documento, status congelado, cancelamento |
| `documents` | documentos emitidos por doação (reemissão reaproveita o registro) |

O histórico é imutável por desenho: cancelar uma doação grava `voided = 1` e o
motivo, sem apagar linhas.
