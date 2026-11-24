#!/bin/zsh
# Pede os valores sem mostrar na tela e roda as execuções da homologação do Bling.
cd "$(dirname "$0")/.." || exit 1
read -s "BA?Access token (da conta que criou o app): " && echo
read -s "BR?Refresh token (Enter se não tiver): " && echo
read -s "CID?Client ID do app: " && echo
read -s "CSEC?Client Secret do app: " && echo
BLING_ACCESS="$BA" BLING_REFRESH="$BR" BLING_CID="$CID" BLING_CSEC="$CSEC" deno run --allow-net --allow-env scripts/bling-homologacao.ts
unset BA BR CID CSEC
