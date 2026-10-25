// Parabéns automático (aniversario-mensy.sql e aniversario-oficial.sql). O
// pg_cron chama de 2 em 2 minutos entre 9h e 21h; a cada chamada sai no máximo
// uma mensagem por loja. As lojas vão ao mesmo tempo: cada uma tem o seu número.
//   nao_oficial  número conectado por QR Code (Mensy): o texto que a loja
//                escreveu, com variações e o primeiro nome.
//   oficial      só quando a loja escolheu e não tem QR Code: o modelo
//                contatta_aniversario aprovado (a Meta cobra como marketing).
//
// Ação rodada: só quem tem o token do cron (x-cron-token).

import type { Json } from '../_shared/asaas.ts'
import { banco, responder, rpc, rpcLinhas } from '../_shared/comum.ts'
import { mandar } from '../_shared/mensy.ts'
import { erroDaMeta, GRAPH, primeiroNome } from '../_shared/primeira-mensagem.ts'
import { envioAniversario, personalizar, tempoDigitando, textoAniversario, variar } from '../_shared/aniversario.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  try {
    const { token: cron } = await rpc('crm_billing_cron_token')
    if (!cron || req.headers.get('x-cron-token') !== cron) return responder(401, { ok: false })
    return responder(200, await rodada())
  } catch (e) {
    console.error('aniversario', e)
    return responder(500, { ok: false })
  }
})

async function rodada(): Promise<Json> {
  const fila = await rpcLinhas('crm_wa_aniversario_fila')
  const feitos = await Promise.all(fila.map(async (f) => {
    const info = f.canal === 'oficial' ? await pelaOficial(f) : await pelaNaoOficial(f)
    if (info.status !== 'enviada') console.error('aniversario', f.customer_id, info.erro)
    await rpc('crm_wa_aniversario_registrar', { p_customer_id: f.customer_id, p_info: info })
    return info.status === 'enviada'
  }))
  return { ok: true, enviadas: feitos.filter(Boolean).length, falhas: feitos.filter((x) => !x).length }
}

async function pelaNaoOficial(f: Json): Promise<Json> {
  const texto = personalizar(variar(f.mensagem), f.nome)
  const r = await mandar(String(f.instance_name), String(f.wa_number), texto, { digitandoMs: tempoDigitando(texto) })
  return 'id' in r
    ? { status: 'enviada', canal: 'nao_oficial', fone: f.wa_number, wamid: `mensy:${r.id}`, texto }
    : { status: 'falhou', canal: 'nao_oficial', fone: f.wa_number, erro: r.erro }
}

async function pelaOficial(f: Json): Promise<Json> {
  const [w] = await rpcLinhas('crm_wa_envio_v2', { p_client_id: f.client_id, p_instance_id: f.instance_id, p_provider: 'cloud_api' })
  if (!w?.token || !w?.phone_number_id) return { status: 'falhou', canal: 'oficial', fone: f.wa_number, erro: 'Número oficial sem acesso.' }
  const { data: num } = await banco.from('wa_instances').select('verified_name').eq('id', f.instance_id).maybeSingle()
  const nome = primeiroNome(f.nome)
  const loja = String(num?.verified_name || f.loja || 'nossa loja')
  const r = await fetch(`${GRAPH}/${w.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(envioAniversario(String(f.wa_number), nome, loja)),
  }).catch(() => null)
  const j = r ? ((await r.json().catch(() => null)) as Json | null) : null
  const wamid = j?.messages?.[0]?.id
  return r?.ok && wamid
    ? { status: 'enviada', canal: 'oficial', fone: f.wa_number, wamid, texto: textoAniversario(nome, loja) }
    : { status: 'falhou', canal: 'oficial', fone: f.wa_number, erro: erroDaMeta(j, r?.status ?? 0) }
}
