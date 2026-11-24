#!/bin/zsh
# Troca o Client ID e o Client Secret do app do Bling nos secrets do Supabase.
# Pede os valores sem mostrar na tela.
cd "$(dirname "$0")/.." || exit 1
read -s "BID?Client ID do app novo: " && echo
read -s "BSEC?Client Secret do app novo: " && echo
if [ -z "$BID" ] || [ -z "$BSEC" ]; then
  echo "Faltou o Client ID ou o Client Secret. Nada foi alterado."
  exit 1
fi
supabase secrets set --project-ref lopdvdblwasuowjdokpo BLING_CLIENT_ID="$BID" BLING_CLIENT_SECRET="$BSEC" && echo "Chaves do Bling trocadas."
unset BID BSEC
