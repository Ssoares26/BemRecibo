#!/usr/bin/env bash
# Define a URL da API usada pela interface (meta tag em frontend/index.html).
#
# Uso:
#   ./deploy/set-api-url.sh https://bemrecibo-api.onrender.com
#   ./deploy/set-api-url.sh ""        # volta para mesma origem
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Uso: $0 <url-da-api-ou-vazio-para-mesma-origem>" >&2
  exit 1
fi

URL="${1%/}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="$ROOT/frontend/index.html"

python3 - "$FILE" "$URL" <<'PY'
import re
import sys

path, url = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    html = handle.read()

pattern = re.compile(r'(<meta name="bemrecibo-api" content=")([^"]*)(">)')
if not pattern.search(html):
    raise SystemExit("Meta tag 'bemrecibo-api' não encontrada em frontend/index.html")

html = pattern.sub(lambda m: f"{m.group(1)}{url}{m.group(3)}", html, count=1)
with open(path, "w", encoding="utf-8") as handle:
    handle.write(html)

print(f"API configurada: {url or 'mesma origem'}")
PY

echo "Arquivo atualizado: frontend/index.html"
echo "Próximo passo: npx wrangler pages deploy   (ou commit + push para o workflow do Pages)"
