/* Funil comercial do Contatta: medição, consentimento, chamadas à função
   funil-publico e o seletor de horários (usado em /demo e /agendar).
   Nada de segredo aqui: só endereços públicos e ids públicos. */
(function () {
  'use strict'

  var CONFIG = {
    // Edge Function pública (Supabase do Contatta)
    api: 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/funil-publico',
    whatsapp: '5581920020337',
    // Preencher quando existir (ver docs/funil-comercial.md). Vazio = desligado.
    pixelId: '2318201022314942', // Pixel "Contatta · site" (ContattaPro), 05/11/2026
    turnstileSiteKey: '',
    // Gravação real da demonstração (90 a 120 s, dados fictícios). Vazio = só a demo clicável.
    videoUrl: '',
    videoPoster: '',
  }
  window.FUNIL_CONFIG = CONFIG

  // ---------------------------------------------------------------- sessão e origem
  function guardar(k, v) { try { sessionStorage.setItem(k, v) } catch (e) {} }
  function ler(k) { try { return sessionStorage.getItem(k) } catch (e) { return null } }
  function guardarLocal(k, v) { try { localStorage.setItem(k, v) } catch (e) {} }
  function lerLocal(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  function novoId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID()
    return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  }

  var origem = {}
  try { origem = JSON.parse(ler('ct-funil-origem') || '{}') } catch (e) {}
  if (!origem.visit_id) origem.visit_id = novoId()
  var q = new URLSearchParams(location.search)
  ;['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ad_id'].forEach(function (k) {
    var v = q.get(k)
    if (v) origem[k] = v.slice(0, 120)
  })
  var fbclid = q.get('fbclid')
  if (fbclid) origem.fbc = 'fb.1.' + Date.now() + '.' + fbclid
  guardar('ct-funil-origem', JSON.stringify(origem))

  function cookie(nome) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + nome + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : ''
  }

  // ---------------------------------------------------------------- API
  function api(corpo, tempo) {
    var ctl = 'AbortController' in window ? new AbortController() : null
    var t = ctl ? setTimeout(function () { ctl.abort() }, tempo || 12000) : null
    return fetch(CONFIG.api, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: corpo.acao === 'evento',
      body: JSON.stringify(corpo), signal: ctl ? ctl.signal : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Resposta inválida.' } })
    }).finally(function () { if (t) clearTimeout(t) })
  }

  var enviados = {}
  function evento(nome, extra) {
    extra = extra || {}
    var chave = nome + ':' + (extra.step || '')
    if ((nome === 'demo_started' || nome === 'demo_completed' || nome === 'form_started' || nome === 'page_view') && enviados[chave]) return
    enviados[chave] = true
    var corpo = {
      acao: 'evento', event: nome, visit_id: origem.visit_id, path: location.pathname, step: extra.step || '',
      utm_source: origem.utm_source || '', utm_medium: origem.utm_medium || '', utm_campaign: origem.utm_campaign || '',
      utm_content: origem.utm_content || '', ad_id: origem.ad_id || '',
      referrer_host: document.referrer ? (function () { try { return new URL(document.referrer).host } catch (e) { return '' } })() : '',
      device: matchMedia('(max-width: 720px)').matches ? 'mobile' : 'desktop',
    }
    api(corpo, 5000).catch(function () {})
  }

  // ---------------------------------------------------------------- consentimento + Pixel
  var medicao = lerLocal('ct-medicao') // 'sim' | 'nao' | null
  function carregarPixel() {
    if (!CONFIG.pixelId || window.fbq) return
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', CONFIG.pixelId)
    window.fbq('track', 'PageView')
  }
  function pixel(nome, dados, idEvento) {
    if (medicao !== 'sim' || !window.fbq) return
    window.fbq('track', nome, dados || {}, idEvento ? { eventID: idEvento } : undefined)
  }
  function iniciarCookies() {
    var barra = document.getElementById('cookies')
    if (!CONFIG.pixelId) { if (barra) barra.remove(); return }
    if (medicao === 'sim') carregarPixel()
    if (!barra || medicao) return
    barra.hidden = false
    barra.querySelector('[data-cookies="sim"]').addEventListener('click', function () {
      medicao = 'sim'; guardarLocal('ct-medicao', 'sim'); barra.hidden = true; carregarPixel()
    })
    barra.querySelector('[data-cookies="nao"]').addEventListener('click', function () {
      medicao = 'nao'; guardarLocal('ct-medicao', 'nao'); barra.hidden = true
    })
  }

  function linkWhats(texto) {
    return 'https://wa.me/' + CONFIG.whatsapp + '?text=' + encodeURIComponent(texto)
  }

  // ---------------------------------------------------------------- seletor de horários
  // monta dias + horários num container; onEscolha(inicio, rotulo)
  function seletorDeHorarios(raiz, horarios, tz, onMudar) {
    raiz.innerHTML = ''
    var porDia = {}
    var ordem = []
    var fmtDia = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'short' })
    var fmtNum = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' })
    var fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    var fmtChave = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    horarios.forEach(function (h) {
      var d = new Date(h.inicio)
      var k = fmtChave.format(d)
      if (!porDia[k]) { porDia[k] = []; ordem.push(k) }
      porDia[k].push(h)
    })
    var dias = document.createElement('div')
    dias.className = 'dias'
    dias.setAttribute('role', 'group')
    dias.setAttribute('aria-label', 'Escolha o dia')
    var horas = document.createElement('div')
    horas.className = 'horas'
    horas.setAttribute('role', 'group')
    horas.setAttribute('aria-label', 'Escolha o horário')
    raiz.appendChild(dias)
    raiz.appendChild(horas)

    function mostrarDia(k) {
      Array.prototype.forEach.call(dias.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.dia === k)) })
      horas.innerHTML = ''
      onMudar(null)
      porDia[k].forEach(function (h) {
        var b = document.createElement('button')
        b.type = 'button'
        b.className = 'hora'
        b.textContent = fmtHora.format(new Date(h.inicio))
        b.setAttribute('aria-pressed', 'false')
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(horas.children, function (x) { x.setAttribute('aria-pressed', 'false') })
          b.setAttribute('aria-pressed', 'true')
          onMudar(h)
        })
        horas.appendChild(b)
      })
    }
    ordem.forEach(function (k, i) {
      var d = new Date(porDia[k][0].inicio)
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'dia'
      b.dataset.dia = k
      b.innerHTML = '<small>' + fmtDia.format(d).replace('.', '') + '</small><b>' + fmtNum.format(d).slice(0, 2) + '</b><small>' + fmtNum.format(d).slice(3) + '</small>'
      b.setAttribute('aria-label', fmtDia.format(d) + ', ' + fmtNum.format(d))
      b.addEventListener('click', function () { mostrarDia(k) })
      dias.appendChild(b)
      if (i === 0) setTimeout(function () { mostrarDia(k) })
    })
  }

  window.Funil = {
    config: CONFIG, origem: origem, api: api, evento: evento, pixel: pixel, iniciarCookies: iniciarCookies,
    linkWhats: linkWhats, seletorDeHorarios: seletorDeHorarios, novoId: novoId, cookie: cookie,
    medicaoAceita: function () { return medicao === 'sim' },
  }
})()
