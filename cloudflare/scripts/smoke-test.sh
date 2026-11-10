#!/usr/bin/env bash
# Verificação rápida do Worker publicado (ou local).
#
# Uso:
#   ./cloudflare/scripts/smoke-test.sh https://bemrecibo.SEU-SUBDOMINIO.workers.dev
#   ./cloudflare/scripts/smoke-test.sh      # usa http://127.0.0.1:8787 (npm run dev)
#   npm run smoke
set -uo pipefail

API="${1:-http://127.0.0.1:8787}"
API="${API%/}"
FAILURES=0

check() {
  local label="$1" path="$2" expected="$3"
  local body code
  body="$(curl -sS --max-time 20 -w '\n%{http_code}' "$API$path" 2>/dev/null)"
  code="$(printf '%s' "$body" | tail -n1)"
  body="$(printf '%s' "$body" | sed '$d')"

  if [ "$code" = "200" ] && printf '%s' "$body" | grep -qF "$expected"; then
    printf '  ok   %-28s %s\n' "$path" "HTTP $code"
  else
    printf '  FALHA %-27s HTTP %s\n' "$path" "$code"
    printf '        esperado conter: %s\n' "$expected"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "Verificando API em $API"
check "saúde" "/health" '"status"'
check "instituição" "/institution" '"name"'
check "indicadores" "/stats" '"donations_count"'
check "doações" "/donations" '['
check "doadores" "/donors" '['
check "interface" "/app.js" 'BemRecibo'

DONATION_ID="$(curl -sS --max-time 20 "$API/donations" 2>/dev/null \
  | python3 -c 'import json,sys
try:
    data = json.load(sys.stdin)
    print(data[0]["id"] if data else "")
except Exception:
    print("")' 2>/dev/null)"

if [ -n "$DONATION_ID" ]; then
  code="$(curl -sS --max-time 30 -o /tmp/bemrecibo-smoke.pdf -w '%{http_code}' \
    "$API/documents/$DONATION_ID/pdf" 2>/dev/null)"
  if [ "$code" = "200" ] && head -c 4 /tmp/bemrecibo-smoke.pdf | grep -q '%PDF'; then
    printf '  ok   %-28s %s (%s bytes)\n' "/documents/$DONATION_ID/pdf" "HTTP $code" \
      "$(wc -c < /tmp/bemrecibo-smoke.pdf)"
    rm -f /tmp/bemrecibo-smoke.pdf
  else
    printf '  FALHA %-27s HTTP %s\n' "/documents/$DONATION_ID/pdf" "$code"
    FAILURES=$((FAILURES + 1))
  fi
else
  printf '  --   %-28s nenhuma doação cadastrada ainda\n' "/documents/{id}/pdf"
fi

CSV_CODE="$(curl -sS --max-time 20 -o /tmp/bemrecibo-smoke.csv -w '%{http_code}' \
  "$API/donations/export.csv" 2>/dev/null)"
if [ "$CSV_CODE" = "200" ] && grep -q 'Número;Data' /tmp/bemrecibo-smoke.csv 2>/dev/null; then
  printf '  ok   %-28s HTTP %s\n' "/donations/export.csv" "$CSV_CODE"
  rm -f /tmp/bemrecibo-smoke.csv
else
  printf '  FALHA %-27s HTTP %s\n' "/donations/export.csv" "$CSV_CODE"
  FAILURES=$((FAILURES + 1))
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "Tudo certo: API respondendo como esperado."
  exit 0
fi
echo "$FAILURES verificação(ões) falharam."
exit 1
