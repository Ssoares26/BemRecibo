# Publicar o BemRecibo no Cloudflare

Guia do deploy completo: **Worker** (API + PDF) + **D1** (banco) + **assets**
(interface). Nada além do Cloudflare é necessário.

Tempo estimado na primeira vez: 10 a 15 minutos.

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

## Caminho rápido (recomendado)

Um único comando faz tudo — login, banco, esquema, dados e publicação:

```bash
cd cloudflare
bash scripts/setup.sh
```

O script é seguro para repetir: cria o banco D1 se ainda não existir, grava o
`database_id` no `wrangler.toml`, aplica o esquema, carrega os dados somente se o
banco estiver vazio e publica o Worker. Para apenas ver o que ele faria, rode
`DRY_RUN=1 bash scripts/setup.sh`.

O restante deste documento detalha cada etapa (útil se algo der errado) e explica
como ligar a publicação automática (pela interface do Cloudflare ou pelo GitHub).

---

## Passo a passo manual

### 1. Instalar as dependências

```bash
cd cloudflare
npm install
```

### 2. Autenticar no Cloudflare

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

### 3. Criar o banco D1

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

### 4. Criar as tabelas no banco de produção

```bash
npm run db:migrate
```

Isso aplica `migrations/0001_init.sql` (`--remote`) e cria as quatro tabelas
(`institution`, `donors`, `donations`, `documents`) com seus índices.

### 5. Carregar os dados que já existiam

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

### 6. Publicar

```bash
npm run deploy
```

A saída mostra o endereço público, por exemplo:

```
https://bemrecibo.SEU-SUBDOMINIO.workers.dev
```

Abra no navegador: a interface carrega e já enxerga o banco D1.

### 7. Ajustes finais dentro do sistema

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

## Primeira publicação pela interface do Cloudflare

Este é o caminho sem terminal. Faça estes passos **depois de o PR desta versão
estar mesclado na `main`**. Não crie Pages: o produto é um Worker.

### 1. Criar o banco D1

1. No painel Cloudflare, abra **Storage & databases → D1 SQL Database** (em
   algumas versões do painel, **Workers & Pages → D1**).
2. Clique em **Create database**, use o nome `bemrecibo` e confirme.
3. Abra o banco recém-criado, copie o **Database ID** (UUID) exibido nos detalhes.

### 2. Ligar o Worker ao D1 no repositório

1. No GitHub, abra `Ssoares26/BemRecibo` na branch `main` e o arquivo
   `cloudflare/wrangler.toml`.
2. Clique em editar e troque apenas o valor de `database_id` (atualmente um
   UUID zero de exemplo) pelo **Database ID** copiado do Cloudflare. Mantenha
   `database_name = "bemrecibo"` e `binding = "DB"`.
3. Salve com **Commit changes** na `main`. Se o Worker já estiver conectado,
   esse commit dispara um novo deploy; se ainda não estiver, crie-o no passo 3
   depois de salvar o ID. O primeiro deploy bem-sucedido precisa encontrar o ID
   real no arquivo.

### 3. Criar o Worker ligado ao GitHub

1. No Cloudflare, vá para **Workers & Pages → Create application → Create
   Worker → Connect to Git** (os rótulos podem aparecer como *Create Worker* e
   *Connect to Git*).
2. Autorize o GitHub e escolha `Ssoares26/BemRecibo`, branch de produção `main`.
3. Em **Build settings**, configure:

   | Campo | Valor |
   | --- | --- |
   | Root directory | `cloudflare` |
   | Build command | `npm ci` |
   | Deploy command | `npx wrangler deploy` |

4. Confirme a criação e aguarde o deploy. Abra a URL `*.workers.dev` indicada.
   No primeiro acesso o Worker cria as tabelas do D1 automaticamente; essa
   inicialização é idempotente e segura se as tabelas já existirem.

> Se você já criou um projeto **Pages**, ele é um produto diferente. Deixe-o
> sem uso ou remova-o; crie um novo projeto **Worker** seguindo os passos acima.
> Não tente corrigir o Pages trocando apenas o comando de deploy.

### 4. Importar os dados existentes pelo console D1

A inicialização cria as tabelas, mas **não carrega os registros**. Para migrar
os dados de exemplo já existentes no sistema:

1. No Cloudflare, abra **Storage & databases → D1 SQL Database → bemrecibo →
   Console**.
2. No GitHub, abra `cloudflare/seed.sql` na branch `main`, clique em **Raw**,
   copie todo o conteúdo e cole no console SQL do D1. Execute os comandos. O
   arquivo é idempotente (`INSERT OR REPLACE`): não duplica IDs se executado de
   novo.
3. Recarregue o app. Você deverá ver **7 doadores, 10 doações e 10 documentos**.

O Worker cria o esquema ao primeiro acesso; se preferir preparar o banco antes
de abrir o app, copie e execute primeiro `cloudflare/migrations/0001_init.sql`
no console D1, depois execute `seed.sql`.

> **Importante:** faça a carga inicial uma única vez, antes de começar a cadastrar
> dados reais. O seed restaura os registros de referência (IDs 1 a 10) e pode
> substituir esses registros se executado novamente. Depois da migração, envie o
> logo, a assinatura e atualize os dados cadastrais na aba **Instituição** —
> imagens locais de demonstração não fazem parte da migração.

---

## Deploy contínuo (opcional)

Depois da primeira publicação manual, dá para deixar cada push na `main` publicar
sozinho. Duas formas:

### A) Cloudflare Workers Builds (pela interface)

1. No painel: **Workers & Pages → bemrecibo → Settings → Builds → Connect**.
2. Autorize o GitHub e escolha o repositório `Ssoares26/BemRecibo`, branch `main`.
3. Preencha exatamente assim:

   | Campo | Valor |
   | --- | --- |
   | Root directory | `cloudflare` |
   | Build command | `npm ci` |
   | Deploy command | `npx wrangler deploy` |

O `Root directory` é essencial: o `wrangler.toml` fica em `cloudflare/`, então o
deploy precisa rodar de dentro dessa pasta.

> **Atenção:** esse projeto é um **Worker**, não um projeto **Pages**. Se você
> criar pelo caminho "Pages", o deploy falha com
> `It seems that you have run wrangler deploy on a Pages project`. Nesse caso,
> apague o projeto Pages e use **Workers & Pages → Create → Workers**.

O Workers Builds publica o código. No primeiro deploy pelo painel, crie o D1,
grave o ID no `wrangler.toml` e importe `seed.sql` seguindo a seção acima. O
Worker cria o esquema automaticamente; o seed continua sendo uma etapa explícita
para evitar sobrescrever dados de produção.

### B) GitHub Actions

O workflow `.github/workflows/deploy-cloudflare.yml` roda os testes e publica a
cada push na `main`. Cadastre em *GitHub → Settings → Secrets and variables →
Actions*:

| Secret | Onde encontrar |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | *My Profile → API Tokens → Create Token → Edit Cloudflare Workers* |
| `CLOUDFLARE_ACCOUNT_ID` | *Workers & Pages → Overview*, coluna da direita |

Sem esses secrets o workflow roda os testes e para (o deploy manual continua
valendo).

---

## Se algo der errado

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| `Missing entry-point to Worker script or to assets directory` | o deploy rodou na raiz do repositório | rode de dentro de `cloudflare/` ou use `bash scripts/setup.sh` |
| `It seems that you have run wrangler deploy on a Pages project` | o projeto criado no painel é **Pages** | apague e crie um **Worker** (veja *Deploy contínuo*) |
| `Couldn't find a D1 DB with binding DB` | ID não configurado ou incorreto | confira se o `database_id` no `cloudflare/wrangler.toml` é o UUID do D1 criado no painel |
| `database_id` ainda é `00000000-…` | o ID real não foi gravado no repositório | edite o arquivo pelo GitHub e aguarde um novo deploy |
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
