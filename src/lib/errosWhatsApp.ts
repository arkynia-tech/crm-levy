/**
 * O erro que a Meta (API oficial) ou o número QR (Mensy/Uazapi) devolve, numa
 * frase: a causa e o que fazer. Usado no log de envios do master.
 * Códigos da Meta: developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */
const POR_CODIGO: Record<string, string> = {
  '131042': 'Conta do WhatsApp da loja sem forma de pagamento válida na Meta. A loja precisa cadastrar o cartão no WhatsApp Manager.',
  '141006': 'Conta do WhatsApp da loja sem forma de pagamento válida na Meta. A loja precisa cadastrar o cartão no WhatsApp Manager.',
  '130472': 'O número faz parte de um experimento da Meta que segura mensagens de marketing. Não é cobrado; teste com outro número.',
  '131026': 'Não entregue: o número não tem WhatsApp, o app está desatualizado ou a pessoa não aceitou os termos novos do WhatsApp.',
  '131047': 'Passou de 24 h desde a última mensagem do cliente: fora dessa janela só sai modelo aprovado.',
  '131049': 'A Meta limitou mensagens de marketing para esse número (já recebeu muitas de empresas).',
  '131050': 'A pessoa parou de receber mensagens de marketing de empresas no WhatsApp.',
  '131051': 'Tipo de mensagem não aceito pelo WhatsApp.',
  '131053': 'Falha ao enviar a mídia (arquivo ou imagem) da mensagem.',
  '131056': 'Mensagens demais para o mesmo número em pouco tempo. Espere antes de mandar de novo.',
  '131000': 'Erro do lado da Meta. Vale tentar de novo.',
  '131005': 'O número da loja perdeu a permissão de envio. Reconecte o WhatsApp oficial.',
  '131008': 'Faltou uma informação obrigatória no envio.',
  '131009': 'Algum dado do envio veio errado (variável do modelo, por exemplo).',
  '131016': 'Serviço do WhatsApp fora do ar no momento. Tente de novo mais tarde.',
  '131021': 'A mensagem foi para o próprio número da loja.',
  '131031': 'A conta do WhatsApp da loja está bloqueada ou restrita pela Meta.',
  '131045': 'O número da loja não está registrado na API oficial. Reconecte o WhatsApp oficial.',
  '131048': 'A Meta segurou os envios por excesso de denúncias ou bloqueios. Pause as campanhas e revise o texto.',
  '131052': 'Não deu para baixar a mídia da mensagem.',
  '132000': 'O número de variáveis não bate com o modelo aprovado.',
  '132001': 'O modelo não existe ou ainda não foi aprovado nesse idioma.',
  '132005': 'O texto ficou grande demais depois de preencher as variáveis.',
  '132007': 'O texto viola a política de conteúdo da Meta.',
  '132012': 'As variáveis vieram em formato que o modelo não aceita.',
  '132015': 'O modelo foi pausado pela Meta por qualidade baixa.',
  '132016': 'O modelo foi desativado pela Meta por qualidade baixa.',
  '133010': 'O número da loja não está registrado no WhatsApp. Reconecte.',
  '368': 'A conta foi bloqueada temporariamente pela Meta por violar a política.',
  '80007': 'Limite de envios da conta atingido. Espere um pouco.',
  '4': 'Limite de chamadas à Meta atingido. Espere um pouco.',
  '190': 'O acesso ao número oficial venceu. Reconecte o WhatsApp oficial.',
}

/** Causa legível do erro; null se não há erro. */
export function causaDoErro(erro: string | null | undefined): string | null {
  const e = (erro ?? '').trim()
  if (!e) return null
  const codigo = /^(\d{1,6})\b/.exec(e)?.[1]
  // número QR (Mensy/Uazapi): vem "503 - {...WhatsApp disconnected...}" ou "500 - {...not on WhatsApp...}"
  if (/disconnected|desconectad|not connected|no session|session.*closed/i.test(e)) {
    return 'O número QR da loja estava desconectado na hora do envio. Reconecte em WhatsApp e mande de novo.'
  }
  if (/not.*(on|in|exist).*whatsapp|n[aã]o (tem|existe).*whatsapp|not a whatsapp|is not registered/i.test(e)) {
    return 'O número não tem WhatsApp.'
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(e)) return 'O serviço do WhatsApp não respondeu a tempo. Vale tentar de novo.'
  if (codigo && POR_CODIGO[codigo]) return POR_CODIGO[codigo]
  return null
}
