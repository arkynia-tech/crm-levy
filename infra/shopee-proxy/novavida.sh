#!/bin/zsh
# Liga o caminho /novavida/ no repasse da VPS (26/10/2026) e confere se a
# NovaVida aceita o login saindo da VPS. Rodar no Mac do Mohamad:
#   zsh infra/shopee-proxy/novavida.sh
# Precisa: ssh mensy-prod e supabase logados. O login e a chave não aparecem.
set -e
cd "$(dirname "$0")"
HOST=shopee-proxy.arkynia.com.br
PROJETO=lopdvdblwasuowjdokpo

echo "1/3 Arquivo novo em /opt/shopee-proxy"
scp -q default.conf.template mensy-prod:/opt/shopee-proxy/

echo "2/3 Recriando o container"
ssh mensy-prod 'cd /opt/shopee-proxy && docker compose up -d --force-recreate' >/dev/null
for i in $(seq 1 12); do
  if curl -s -m 5 https://$HOST/saude | grep -q ok; then break; fi
  sleep 5
done

echo "3/3 Login da NovaVida saindo da VPS"
K=$(ssh mensy-prod 'grep ^PROXY_CHAVE= /opt/shopee-proxy/.env | cut -d= -f2')
SK=$(supabase projects api-keys --project-ref $PROJETO -o json 2>/dev/null | sed -n '/^\[/,$p' \
  | python3 -I -c "import json,sys;print([k['api_key'] for k in json.load(sys.stdin) if k['name']=='service_role'][0])")
SEM=$(curl -s -o /dev/null -m 10 -w "%{http_code}" -X POST https://$HOST/novavida/wslocalizador.asmx/GerarTokenJson)
K="$K" SK="$SK" HOST="$HOST" PROJETO="$PROJETO" python3 -I - <<'EOF'
import json, os, urllib.request
sk = os.environ['SK']
req = urllib.request.Request(f"https://{os.environ['PROJETO']}.supabase.co/rest/v1/integration_secrets?key=eq.novavida&select=value",
                             headers={'apikey': sk, 'Authorization': f'Bearer {sk}'})
c = json.loads(urllib.request.urlopen(req, timeout=30).read())[0]['value']
req = urllib.request.Request(f"https://{os.environ['HOST']}/novavida/wslocalizador.asmx/GerarTokenJson", method='POST',
                             headers={'Content-Type': 'application/json', 'x-contatta-proxy': os.environ['K']},
                             data=json.dumps({'credencial': {'usuario': c['usuario'], 'senha': c['senha'], 'cliente': c['cliente']}}).encode())
try:
    d = str(json.loads(urllib.request.urlopen(req, timeout=30).read() or 'null').get('d') or '')
except Exception as e:
    d = f'erro: {e}'
print('    a NovaVida, pela VPS:', 'ACEITOU o login' if len(d) > 40 else 'RECUSOU: ' + d[:150])
EOF
unset K SK
echo "    sem a chave: HTTP $SEM (tem que ser 403)"
echo "Pode voltar para a conversa."
