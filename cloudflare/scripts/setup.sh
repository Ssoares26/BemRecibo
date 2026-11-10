#!/usr/bin/env bash
# =============================================================================
# BemRecibo — publicação no Cloudflare em um comando.
#
#   cd cloudflare
#   bash scripts/setup.sh
#
# O script:
#   1. confere autenticação (abre `wrangler login` se necessário);
#   2. cria o banco D1 e grava o database_id no wrangler.toml;
#   3. aplica o esquema no banco de produção;
#   4. carrega os dados migrados (só se o banco estiver vazio);
#   5. publica o Worker.
#
# É seguro repetir: cada etapa confere antes de agir.
# Para apenas ver o que seria feito, use: DRY_RUN=1 bash scripts/setup.sh
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN="${DRY_RUN:-0}"
PLACEHOLDER="00000000-0000-0000-0000-000000000000"
DB_NAME="bemrecibo"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '   %s\n' "$1"; }
fail() { printf '\n\033[31m✘ %s\033[0m\n' "$1" >&2; exit 1; }
run()  {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

command -v npx >/dev/null 2>&1 || fail "Node.js não encontrado. Instale em https://nodejs.org (versão 20 ou superior)."
[ -f wrangler.toml ] || fail "wrangler.toml não encontrado. Rode este script de dentro da pasta cloudflare."

# -----------------------------------------------------------------------------
bold "1/5 · Autenticação no Cloudflare"
if [ "$DRY_RUN" = "1" ]; then
  info "[dry-run] npx wrangler whoami"
elif npx wrangler whoami >/dev/null 2>&1; then
  info "Sessão válida: $(npx wrangler whoami 2>/dev/null | sed -n 's/.*associated with the email \(.*\)\.$/\1/p' | head -1)"
else
  info "Abrindo o navegador para autorizar o wrangler..."
  npx wrangler login || fail "Login não concluído. Alternativa: export CLOUDFLARE_API_TOKEN=... e rode de novo."
fi

# -----------------------------------------------------------------------------
bold "2/5 · Banco D1"
current_id="$(sed -n 's/^database_id *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -1)"
current_id="${current_id:-$PLACEHOLDER}"

patch_id() {
  local new_id="$1"
  awk -v id="$new_id" '
    /^database_id *=/ { print "database_id = \"" id "\""; next }
    { print }
  ' wrangler.toml > wrangler.toml.tmp && mv wrangler.toml.tmp wrangler.toml
  info "database_id gravado em wrangler.toml: $new_id"
}

if [ "$current_id" != "$PLACEHOLDER" ]; then
  info "Banco já configurado (database_id: $current_id)."
else
  info "Criando o banco D1 '$DB_NAME'..."
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] npx wrangler d1 create $DB_NAME  → gravaria o database_id no wrangler.toml"
    new_id=""
  else
    create_out=""
    if create_out="$(npx wrangler d1 create "$DB_NAME" 2>&1)"; then
      new_id="$(printf '%s\n' "$create_out" | sed -n 's/.*database_id *= *"\([^"]*\)".*/\1/p' | head -1)"
    else
      info "O banco '$DB_NAME' parece já existir; procurando o identificador..."
      new_id="$(npx wrangler d1 list --json 2>/dev/null \
        | tr '}' '\n' | grep "\"$DB_NAME\"" \
        | sed -n 's/.*"uuid" *: *"\([^"]*\)".*/\1/p' | head -1)"
    fi
    [ -n "${new_id:-}" ] || fail "Não foi possível obter o database_id.
Abra https://dash.cloudflare.com → Storage & Databases → D1 → $DB_NAME,
copie o ID e cole em wrangler.toml na linha database_id."
  fi
  if [ -n "${new_id:-}" ]; then
    patch_id "$new_id"
  fi
fi

# -----------------------------------------------------------------------------
bold "3/5 · Esquema do banco"
run npx wrangler d1 migrations apply "$DB_NAME" --remote

# -----------------------------------------------------------------------------
bold "4/5 · Dados existentes"
if [ "$DRY_RUN" = "1" ]; then
  info "[dry-run] verifica a contagem de doadores e aplica seed.sql se estiver vazio"
else
  count="$(npx wrangler d1 execute "$DB_NAME" --remote --json \
    --command "SELECT COUNT(*) AS n FROM donors" 2>/dev/null \
    | tr -d ' \n' | sed -n 's/.*"n":\([0-9]*\).*/\1/p' | head -1)"
  count="${count:-0}"
  if [ "$count" = "0" ]; then
    info "Banco vazio: carregando seed.sql (doadores, doações e documentos)..."
    run npx wrangler d1 execute "$DB_NAME" --remote --file=seed.sql
  else
    info "O banco já tem $count doador(es); seed.sql não foi reaplicado."
  fi
fi

# -----------------------------------------------------------------------------
bold "5/5 · Publicando o Worker"
run npx wrangler deploy

bold "Pronto!"
info "Acesse o endereço mostrado acima (algo como https://$DB_NAME.SEU-SUBDOMINIO.workers.dev)."
info "Depois, na aba Instituição, envie o logotipo, a assinatura e (se já existir) o comprovante de habilitação."
