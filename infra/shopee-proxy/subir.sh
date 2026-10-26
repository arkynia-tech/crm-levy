#!/bin/zsh
# Sobe o repasse de IP fixo da Shopee na VPS arkynia.prod (31.97.26.181).
# Rodar no Mac do Mohamad, nesta pasta:  zsh infra/shopee-proxy/subir.sh
# Precisa: ssh mensy-prod, vercel e supabase logados. A chave do repasse é
# gerada aqui, vai direto para o .env da VPS e para o Supabase, e não aparece.
set -e
cd "$(dirname "$0")"
HOST=shopee-proxy.arkynia.com.br
IP=31.97.26.181
PROJETO=lopdvdblwasuowjdokpo

echo "1/6 DNS: $HOST -> $IP"
if dig +short $HOST @1.1.1.1 | grep -q "$IP"; then
  echo "    já aponta"
else
  vercel dns add arkynia.com.br shopee-proxy A $IP
fi

echo "2/6 Traefik na VPS (lendo os labels do n8n-dev)"
INFO=$(ssh mensy-prod 'c=$(docker ps --format "{{.Names}}" | grep -i n8n | head -1); t=$(docker ps --format "{{.Names}}" | grep -i traefik | head -1);
  docker inspect "$c" --format "{{range \$k,\$v := .Config.Labels}}{{\$k}}={{\$v}}{{println}}{{end}}" | grep -E "routers\..*\.(tls\.certresolver|entrypoints)=" ;
  echo "rede=$(docker inspect "$t" --format "{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}" | tr " " "\n" | grep -v "^$" | head -1)"')
RESOLVER=$(echo "$INFO" | grep certresolver= | head -1 | cut -d= -f2)
ENTRY=$(echo "$INFO" | grep entrypoints= | head -1 | cut -d= -f2 | cut -d, -f1)
REDE=$(echo "$INFO" | grep ^rede= | cut -d= -f2)
echo "    rede=$REDE entrypoint=$ENTRY certresolver=$RESOLVER"
if [ -z "$REDE" ] || [ -z "$ENTRY" ] || [ -z "$RESOLVER" ]; then
  echo "Não achei a configuração do Traefik. Nada foi alterado na VPS."; exit 1
fi

echo "3/6 Arquivos em /opt/shopee-proxy"
ssh mensy-prod 'mkdir -p /opt/shopee-proxy'
scp -q default.conf.template docker-compose.yml mensy-prod:/opt/shopee-proxy/

echo "4/6 Chave do repasse (VPS e Supabase)"
K=$(openssl rand -hex 24)
printf 'PROXY_CHAVE=%s\nCERT_RESOLVER=%s\nTRAEFIK_NETWORK=%s\nENTRYPOINT=%s\n' "$K" "$RESOLVER" "$REDE" "$ENTRY" \
  | ssh mensy-prod 'umask 077; cat > /opt/shopee-proxy/.env'
supabase secrets set --project-ref $PROJETO SHOPEE_PROXY_CHAVE="$K" >/dev/null

echo "5/6 Subindo o container"
ssh mensy-prod 'cd /opt/shopee-proxy && docker compose up -d'

echo "6/6 Conferindo (o certificado pode levar até 1 minuto)"
for i in $(seq 1 18); do
  if curl -s -m 5 https://$HOST/saude | grep -q ok; then break; fi
  sleep 5
done
SEM=$(curl -s -o /dev/null -m 10 -w "%{http_code}" "https://$HOST/sandbox/api/v2/public/get_shops_by_partner?partner_id=1&timestamp=1&sign=x")
COM=$(curl -s -m 10 -H "x-contatta-proxy: $K" "https://$HOST/sandbox/api/v2/public/get_shops_by_partner?partner_id=1&timestamp=1&sign=x")
unset K
echo "    sem a chave: HTTP $SEM (tem que ser 403)"
echo "    com a chave, a Shopee respondeu: $COM"
if [ "$SEM" = "403" ] && echo "$COM" | grep -q '"error"'; then
  echo "Repasse no ar. Pode voltar para a conversa."
else
  echo "Algo não bateu: copie as linhas acima para a conversa."
fi
