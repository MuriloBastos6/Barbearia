'use strict';
// Thiago Barbearia - agendamento com sinal via Pix (confirmação manual)
// Versão para Vercel: função serverless + banco Redis (Upstash). Sem dependências externas.

const crypto = require('crypto');

// ---------- Configuração (variáveis de ambiente) ----------
const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PIX_NAME = process.env.PIX_NAME || 'THIAGO BARBEARIA';     // nome do recebedor (máx. 25 letras)
const PIX_CITY = process.env.PIX_CITY || 'SAO PAULO';            // cidade (máx. 15 letras)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';         // senha do painel /admin
const WHATSAPP = String(process.env.WHATSAPP || '').replace(/\D/g, ''); // (opcional) WhatsApp da barbearia, para o cliente pedir o código de nova senha
// Mercado Pago (opcional): com o Access Token, o cliente paga por Pix, crédito ou débito no
// checkout do Mercado Pago e o horário se confirma sozinho. Sem ele, vale o Pix manual.
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');   // (opcional) endereço do site; sem ele, usa o da requisição
const DEPOSIT = '20.00';                                         // valor do sinal
const HOLD_MIN = +process.env.HOLD_MIN || 15;                    // minutos que o horário fica reservado aguardando o Pix
const HOLD_GRACE_MS = 10000;                                     // folga para o relógio do banco não vencer antes do nosso
const MAX_DAYS_AHEAD = 21;
const TZ = 'America/Sao_Paulo';
// Segunda a sábado, blocos de 1 hora, do primeiro às 10:00 até o último às 19:00 (termina 20:00)
const SLOTS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];
const SLOT_MIN = 60;
// Horários da grade antiga (1h30). Agendamentos já feitos nela continuam ocupando o horário novo
// que se sobrepõe a eles. Pode apagar isto depois de 45 dias, quando essas reservas já tiverem passado.
const OLD_SLOTS = ['11:30', '14:30', '17:30', '20:30'], OLD_MIN = 90;
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3);
const BOOKING_TTL = 60 * 24 * 3600;   // registros somem sozinhos após 60 dias
const SLOT_TTL = 45 * 24 * 3600;
const SESSION_TTL = 30 * 24 * 3600;   // cliente fica logado por 30 dias
const RESET_TTL = 30 * 60;            // código para nova senha vale 30 minutos

// ---------- Chave Pix ----------
// Ajustada para o formato que os bancos exigem: telefone vira +55DDDNUMERO, e-mail e chave
// aleatória ficam em minúsculas, CPF/CNPJ só com números.
function validCPF(c) {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i);
    if (((s * 10) % 11) % 10 !== +c[n]) return false;
  }
  return true;
}
function normalizePixKey(raw) {
  const k = String(raw || '').trim();
  if (!k) return '';
  if (k.includes('@')) return k.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return k.toLowerCase();
  if (k.startsWith('+')) return '+' + k.replace(/\D/g, '');
  const d = k.replace(/\D/g, '');
  const formatted = /[()\-\s.\/]/.test(k);
  if (d.length === 14) return d;
  if (d.length === 11 && (validCPF(d) && !(formatted && /\(/.test(k)))) return d;
  if (d.length === 11 || d.length === 10) return '+55' + d;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return '+' + d;
  return d || k;
}
const PIX_KEY = normalizePixKey(process.env.PIX_KEY);

// ---------- Redis (Upstash, via REST) ----------
async function redisPipe(cmds) {
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map(c => c.map(String)))
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(j)) throw new Error('Banco de dados indisponível');
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const redis = async (...cmd) => (await redisPipe([cmd]))[0];

// Scripts atômicos: só mexem na reserva do horário se ela ainda pertencer a este agendamento.
const LUA_CLAIM = "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]) return 1 else return 0 end";
const LUA_RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
const slotKey = (date, time) => `slot:${date}:${time}`;
// Pagamento aprovado pelo Mercado Pago: fica com o horário se ainda for deste agendamento ou se
// tiver vagado (o Pix pode ser pago depois de a reserva vencer).
const LUA_TAKE = "local v=redis.call('GET',KEYS[1]) if v==ARGV[1] or not v then redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]) return 1 else return 0 end";
const LUA_HOLD = "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2]) return 1 else return 0 end";
const takeSlot = async b => (await redis('EVAL', LUA_TAKE, 1, slotKey(b.date, b.time), b.id, SLOT_TTL)) === 1;
const claimSlot = async b => (await redis('EVAL', LUA_CLAIM, 1, slotKey(b.date, b.time), b.id, SLOT_TTL)) === 1;
const releaseSlot = b => redis('EVAL', LUA_RELEASE, 1, slotKey(b.date, b.time), b.id);

async function getBooking(id) {
  const raw = await redis('GET', 'b:' + id);
  return raw ? JSON.parse(raw) : null;
}
const saveBooking = b => redis('SET', 'b:' + b.id, JSON.stringify(b), 'EX', BOOKING_TTL);

// ---------- Contas de clientes ----------
// Conta = WhatsApp + senha. A senha é guardada só como hash (scrypt com sal).
const scrypt = (pw, salt) => new Promise((ok, fail) => crypto.scrypt(pw, salt, 32, (e, k) => e ? fail(e) : ok(k.toString('hex'))));
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d;
}
const validPhone = d => d.length === 10 || d.length === 11;
async function getUser(phone) {
  const raw = await redis('GET', 'user:' + phone);
  return raw ? JSON.parse(raw) : null;
}
// A sessão guarda "telefone:versão da senha". Trocar a senha muda a versão e derruba
// as sessões abertas em outros aparelhos.
async function newSession(u) {
  const token = crypto.randomBytes(24).toString('hex');
  await redis('SET', 'sess:' + token, u.phone + ':' + (u.ver || 0), 'EX', SESSION_TTL);
  return token;
}
function bearer(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer ([a-f0-9]{48})$/);
  return m ? m[1] : null;
}
async function currentUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const val = await redis('GET', 'sess:' + token);
  if (!val) return null;
  const [phone, ver = '0'] = val.split(':');
  const u = await getUser(phone);
  return u && String(u.ver || 0) === ver ? u : null;
}
async function setPassword(u, pw) {
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = await scrypt(pw, u.salt);
  u.ver = (u.ver || 0) + 1;
  await redis('SET', 'user:' + u.phone, JSON.stringify(u));
}
const badPassword = pw => pw.length < 6 || pw.length > 100;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const publicUser = u => ({ name: u.name, phone: u.phone });
// Liga ao histórico da conta um agendamento que o cliente fez sem estar logado (ele precisa
// ter o id, que só fica salvo no aparelho onde agendou, e o WhatsApp precisa ser o mesmo).
async function attachBooking(u, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return;
  const b = await getBooking(id);
  if (b && normPhone(b.phone) === u.phone) await redis('SADD', 'ubk:' + u.phone, b.id);
}

// ---------- Datas (sempre no horário de São Paulo) ----------
function nowSP() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: TZ }); // "2026-10-13 13:49:00"
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekday(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); } // 0 = domingo
function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00Z')); }
function openDays() {
  const today = nowSP().date, out = [];
  for (let i = 0; i <= MAX_DAYS_AHEAD; i++) {
    const d = addDays(today, i);
    if (weekday(d) !== 0) out.push(d);
  }
  return out;
}

// ---------- Horários ----------
function isPast(date, time) {
  const now = nowSP();
  return date < now.date || (date === now.date && time <= now.time);
}
async function dayStatus(date) {
  const [taken, blocks, old] = await redisPipe([
    ['MGET', ...SLOTS.map(t => slotKey(date, t))], ['SMEMBERS', 'blocks'], ['MGET', ...OLD_SLOTS.map(t => slotKey(date, t))]
  ]);
  const wholeDay = blocks.includes(date + '|');
  // 10:00, 13:00, 16:00 e 19:00 existem nas duas grades: uma reserva antiga às 10:00 (até 11:30)
  // usa a chave das 10:00 e ainda precisa ocupar as 11:00. Reservas novas guardam "dur: 60".
  const shared = ['10:00', '13:00', '16:00', '19:00'].filter(t => taken[SLOTS.indexOf(t)]);
  const sharedBk = shared.length ? await redis('MGET', ...shared.map(t => 'b:' + taken[SLOTS.indexOf(t)])) : [];
  const oldTaken = OLD_SLOTS.filter((t, i) => old[i])
    .concat(shared.filter((t, i) => sharedBk[i] && !JSON.parse(sharedBk[i]).dur));
  const overlapsOld = t => oldTaken.some(o => toMin(o) < toMin(t) + SLOT_MIN && toMin(t) < toMin(o) + OLD_MIN);
  return SLOTS.map((time, i) => ({
    time,
    status: isPast(date, time) ? 'past' : (wholeDay || blocks.includes(`${date}|${time}`)) ? 'blocked' : (taken[i] || overlapsOld(time)) ? 'taken' : 'free'
  }));
}

// ---------- Pix "copia e cola" (BR Code estático) ----------
function tlv(id, val) { return id + String(val.length).padStart(2, '0') + val; }
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function ascii(s, max) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, max);
}
function pixPayload() {
  const body =
    tlv('00', '01') +
    tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', PIX_KEY)) +
    tlv('52', '0000') + tlv('53', '986') + tlv('54', DEPOSIT) + tlv('58', 'BR') +
    tlv('59', ascii(PIX_NAME, 25) || 'BARBEARIA') +
    tlv('60', ascii(PIX_CITY, 15) || 'SAO PAULO') +
    tlv('62', tlv('05', '***')) +   // "***" = sem identificador, o formato aceito por todos os bancos
    '6304';
  return body + crc16(body);
}
function publicBooking(b) {
  const status = (b.status === 'pending' && Date.now() >= b.expiresAt) ? 'expired' : b.status;
  const out = { id: b.id, name: b.name, date: b.date, time: b.time, status, expiresAt: b.expiresAt, amount: DEPOSIT };
  if (b.checkoutUrl) out.checkoutUrl = b.checkoutUrl;
  else out.pix = { payload: pixPayload(), key: PIX_KEY, name: PIX_NAME, amount: DEPOSIT };
  return out;
}

// ---------- Mercado Pago (Checkout Pro) ----------
async function mp(method, path, body, extraHeaders) {
  const r = await fetch('https://api.mercadopago.com' + path, {
    method,
    headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Mercado Pago', r.status, j);
    const e = new Error('Mercado Pago indisponível'); e.status = r.status; throw e;
  }
  return j;
}
function siteUrl(req) {
  if (SITE_URL) return SITE_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return proto + '://' + host;
}
function createPreference(b, req) {
  const base = siteUrl(req);
  const back = base + '/?pagamento=' + b.id;
  return mp('POST', '/checkout/preferences', {
    items: [{ id: 'sinal', title: `Sinal - ${PIX_NAME} ${b.date.split('-').reverse().join('/')} ${b.time}`, quantity: 1, unit_price: +DEPOSIT, currency_id: 'BRL' }],
    external_reference: b.id,
    // Pix, crédito, débito e saldo do Mercado Pago. Boleto fica de fora (demora dias para compensar).
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }], installments: 1 },
    back_urls: { success: back, pending: back, failure: back },
    auto_return: 'approved',
    notification_url: base + '/api/mp/webhook',
    statement_descriptor: ascii(PIX_NAME, 22),
    expires: true,
    expiration_date_from: new Date(b.createdAt - 60000).toISOString(),
    expiration_date_to: new Date(b.expiresAt).toISOString()
  }, { 'X-Idempotency-Key': 'pref-' + b.id });
}
// Aplica ao agendamento o que o Mercado Pago diz sobre um pagamento. Os dados vêm sempre da API
// do Mercado Pago com o nosso token, então um aviso falso no webhook não confirma nada.
async function applyPayment(pay) {
  const id = String(pay.external_reference || '');
  if (!/^[a-f0-9]{32}$/.test(id)) return;
  const b = await getBooking(id);
  if (!b || !b.checkoutUrl) return;
  if (pay.status === 'approved') {
    if (b.status === 'confirmed' || b.status === 'refunded') {
      if (b.mpPaymentId !== pay.id) await refundPayment(pay.id);   // pagou duas vezes: devolve a segunda
      return;
    }
    if (b.status !== 'cancelled' && await takeSlot(b)) {
      b.status = 'confirmed';
    } else {
      // O horário foi para outra pessoa (ou foi cancelado) antes de o pagamento cair: devolve o dinheiro.
      await releaseSlot(b);
      b.status = (await refundPayment(pay.id)) ? 'refunded' : 'refund_needed';
    }
    b.mpPaymentId = pay.id; b.paidAt = Date.now();
    await saveBooking(b);
  } else if ((pay.status === 'in_process' || pay.status === 'authorized') && b.status === 'pending') {
    // Cartão em análise pelo Mercado Pago: segura o horário até sair a resposta.
    if (await takeSlot(b)) { b.status = 'paid_claimed'; b.mpPaymentId = pay.id; await saveBooking(b); }
  } else if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(pay.status) && b.status === 'paid_claimed' && b.mpPaymentId === pay.id) {
    // Análise recusada: volta a ser uma reserva comum (que vence no horário de sempre).
    b.status = 'pending';
    const left = b.expiresAt - Date.now();
    if (left <= 0) await releaseSlot(b);
    else await redis('EVAL', LUA_HOLD, 1, slotKey(b.date, b.time), b.id, Math.round(left + HOLD_GRACE_MS));
    await saveBooking(b);
  }
}
async function refundPayment(paymentId) {
  try { await mp('POST', `/v1/payments/${paymentId}/refunds`, {}, { 'X-Idempotency-Key': 'refund-' + paymentId }); return true; }
  catch (_) { return false; }
}
// Consulta os pagamentos de um agendamento. Cobre o caso de o aviso (webhook) do Mercado Pago atrasar ou se perder.
async function syncBooking(b) {
  if (!MP_TOKEN || !b.checkoutUrl || !['pending', 'paid_claimed'].includes(b.status)) return b;
  if ((await redis('SET', 'sync:' + b.id, '1', 'NX', 'EX', 4)) !== 'OK') return b;
  const r = await mp('GET', '/v1/payments/search?external_reference=' + b.id + '&sort=date_created&criteria=desc');
  const list = r.results || [];
  const best = list.find(x => x.status === 'approved') || list.find(x => x.status === 'in_process' || x.status === 'authorized') || list[0];
  if (best) await applyPayment(best);
  return (await getBooking(b.id)) || b;
}

// ---------- Utilidades HTTP ----------
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) return JSON.parse(req.body);
  if (req.readableEnded) return {};
  let data = '';
  for await (const c of req) { data += c; if (data.length > 10000) throw new Error('grande'); }
  return data ? JSON.parse(data) : {};
}
function adminOk(req) {
  if (!ADMIN_PASSWORD) return false;
  const given = Buffer.from(String(req.headers['x-admin-password'] || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'x').split(',')[0].trim();
}

// ---------- Rotas ----------
async function route(req, res, p, query, readJson) {
  const method = req.method;

  if (method === 'GET' && p === '/config') {
    return send(res, 200, { name: 'Thiago Barbearia', deposit: DEPOSIT, holdMin: HOLD_MIN, days: openDays(), pixConfigured: !!(PIX_KEY || MP_TOKEN), checkout: MP_TOKEN ? 'mercadopago' : 'pix', whatsapp: WHATSAPP });
  }

  if (method === 'GET' && p === '/slots') {
    const date = query.date;
    if (!validDate(date) || weekday(date) === 0 || !openDays().includes(date)) return send(res, 400, { error: 'Data indisponível.' });
    return send(res, 200, await dayStatus(date));
  }

  if (method === 'POST' && p === '/book') {
    if (!PIX_KEY && !MP_TOKEN) return send(res, 503, { error: 'Pagamento ainda não configurado.' });
    const { name, phone, date, time } = await readJson();
    const user = await currentUser(req);
    const cleanName = String(name || '').trim().slice(0, 60);
    // Logado, o agendamento vai sempre para o WhatsApp da conta.
    const digits = user ? user.phone : normPhone(phone);
    if (cleanName.length < 2) return send(res, 400, { error: 'Informe seu nome.' });
    if (!validPhone(digits)) return send(res, 400, { error: 'Informe um WhatsApp válido com DDD.' });
    if (!validDate(date) || !SLOTS.includes(time) || !openDays().includes(date)) return send(res, 400, { error: 'Horário inválido.' });
    const current = (await dayStatus(date)).find(s => s.time === time);
    if (current.status !== 'free') return send(res, 409, { error: 'Esse horário acabou de ser ocupado. Escolha outro.' });

    const b = {
      id: crypto.randomBytes(16).toString('hex'), name: cleanName, phone: digits, date, time,
      status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + HOLD_MIN * 60 * 1000, dur: SLOT_MIN
    };
    // Reserva atômica: só um cliente consegue criar a chave do horário.
    const got = await redis('SET', slotKey(date, time), b.id, 'NX', 'PX', Math.round(HOLD_MIN * 60000 + HOLD_GRACE_MS));
    if (got !== 'OK') return send(res, 409, { error: 'Esse horário acabou de ser ocupado. Escolha outro.' });
    // No máximo 2 reservas aguardando pagamento por telefone ao mesmo tempo.
    const [n] = await redisPipe([['INCR', 'ph:' + digits], ['EXPIRE', 'ph:' + digits, Math.round(HOLD_MIN * 60), 'NX']]);
    if (n > 2) {
      await releaseSlot(b);
      return send(res, 429, { error: 'Você já tem reservas aguardando pagamento. Conclua ou aguarde expirar.' });
    }
    if (MP_TOKEN) {
      try { b.checkoutUrl = (await createPreference(b, req)).init_point; }
      catch (e) {
        await releaseSlot(b);
        return send(res, 502, { error: 'Não foi possível abrir o pagamento agora. Tente novamente em instantes.' });
      }
    }
    const cmds = [['SET', 'b:' + b.id, JSON.stringify(b), 'EX', BOOKING_TTL], ['SADD', 'ids', b.id]];
    if (user) cmds.push(['SADD', 'ubk:' + user.phone, b.id]);
    await redisPipe(cmds);
    return send(res, 201, publicBooking(b));
  }

  // ----- Conta do cliente -----
  if (method === 'POST' && (p === '/auth/register' || p === '/auth/login')) {
    const { name, phone, password, bookingId } = await readJson();
    const digits = normPhone(phone);
    const pw = String(password || '');
    if (!validPhone(digits)) return send(res, 400, { error: 'Informe um WhatsApp válido com DDD.' });
    const ip = clientIp(req);
    const [ipFails, phFails] = (await redisPipe([['GET', 'lfail:' + ip], ['GET', 'lfailp:' + digits]])).map(x => +x || 0);
    if (ipFails >= 10 || phFails >= 10) return send(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos.' });

    let user;
    if (p === '/auth/register') {
      const cleanName = String(name || '').trim().slice(0, 60);
      if (cleanName.length < 2) return send(res, 400, { error: 'Informe seu nome.' });
      if (badPassword(pw)) return send(res, 400, { error: 'A senha precisa ter pelo menos 6 caracteres.' });
      const salt = crypto.randomBytes(16).toString('hex');
      user = { phone: digits, name: cleanName, salt, hash: await scrypt(pw, salt), createdAt: Date.now() };
      if ((await redis('SET', 'user:' + digits, JSON.stringify(user), 'NX')) !== 'OK') {
        return send(res, 409, { error: 'Já existe uma conta com esse WhatsApp. Entre com sua senha.' });
      }
    } else {
      user = await getUser(digits);
      const ok = user && pw.length <= 100 &&
        crypto.timingSafeEqual(Buffer.from(await scrypt(pw, user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
      if (!ok) {
        await redisPipe([['INCR', 'lfail:' + ip], ['EXPIRE', 'lfail:' + ip, 600, 'NX'], ['INCR', 'lfailp:' + digits], ['EXPIRE', 'lfailp:' + digits, 600, 'NX']]);
        return send(res, 401, { error: 'WhatsApp ou senha incorretos.' });
      }
    }
    await attachBooking(user, bookingId);
    return send(res, 200, { token: await newSession(user), user: publicUser(user) });
  }
  // Esqueci a senha: o dono gera o código no painel e manda pelo WhatsApp do cliente.
  if (method === 'POST' && p === '/auth/reset') {
    const { phone, code, password } = await readJson();
    const digits = normPhone(phone);
    const pw = String(password || '');
    if (!validPhone(digits)) return send(res, 400, { error: 'Informe um WhatsApp válido com DDD.' });
    if (badPassword(pw)) return send(res, 400, { error: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    const saved = await redis('GET', 'reset:' + digits);
    if (!saved) return send(res, 400, { error: 'Código inválido ou vencido. Peça um novo código.' });
    const given = sha(digits + ':' + String(code || '').replace(/\D/g, ''));
    if (given !== saved) {
      // 5 tentativas erradas e o código deixa de valer.
      const [n] = await redisPipe([['INCR', 'rfail:' + digits], ['EXPIRE', 'rfail:' + digits, RESET_TTL, 'NX']]);
      if (n >= 5) await redisPipe([['DEL', 'reset:' + digits], ['DEL', 'rfail:' + digits]]);
      return send(res, 400, { error: n >= 5 ? 'Código errado muitas vezes. Peça um novo código.' : 'Código incorreto.' });
    }
    const user = await getUser(digits);
    if (!user) return send(res, 400, { error: 'Código inválido ou vencido. Peça um novo código.' });
    await setPassword(user, pw);
    await redisPipe([['DEL', 'reset:' + digits], ['DEL', 'rfail:' + digits], ['DEL', 'lfailp:' + digits]]);
    return send(res, 200, { token: await newSession(user), user: publicUser(user) });
  }
  if (method === 'POST' && p === '/auth/password') {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Entre na sua conta para ver seus agendamentos.' });
    const { current, password } = await readJson();
    const pw = String(password || ''), cur = String(current || '');
    const ok = cur.length <= 100 &&
      crypto.timingSafeEqual(Buffer.from(await scrypt(cur, user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
    if (!ok) return send(res, 400, { error: 'Senha atual incorreta.' });
    if (badPassword(pw)) return send(res, 400, { error: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    await setPassword(user, pw);
    return send(res, 200, { token: await newSession(user), user: publicUser(user) });
  }
  if (method === 'POST' && p === '/auth/logout') {
    const token = bearer(req);
    if (token) await redis('DEL', 'sess:' + token);
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && p === '/me') {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Entre na sua conta para ver seus agendamentos.' });
    const ids = await redis('SMEMBERS', 'ubk:' + user.phone);
    const bookings = [];
    if (ids.length) {
      const vals = await redis('MGET', ...ids.map(i => 'b:' + i));
      const stale = [];
      vals.forEach((v, i) => { if (v) bookings.push(JSON.parse(v)); else stale.push(ids[i]); });
      if (stale.length) await redis('SREM', 'ubk:' + user.phone, ...stale);
    }
    const history = bookings
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
      .map(b => { const pb = publicBooking(b); return { id: pb.id, name: pb.name, date: pb.date, time: pb.time, status: pb.status }; });
    return send(res, 200, { user: publicUser(user), bookings: history });
  }

  let m;
  if ((m = p.match(/^\/booking\/([a-f0-9]{32})$/)) && method === 'GET') {
    let b = await getBooking(m[1]);
    if (b) { try { b = await syncBooking(b); } catch (_) { /* Mercado Pago fora do ar: mostra o que já sabemos */ } }
    return b ? send(res, 200, publicBooking(b)) : send(res, 404, { error: 'Agendamento não encontrado.' });
  }
  // Aviso do Mercado Pago de que um pagamento mudou. Respondemos 200 sempre, para ele não reenviar sem fim.
  if (p === '/mp/webhook' && (method === 'POST' || method === 'GET')) {
    if (!MP_TOKEN) return send(res, 200, { ok: true });
    let body = {};
    try { body = method === 'POST' ? await readJson() : {}; } catch (_) {}
    const type = body.type || body.topic || query.type || query.topic;
    const id = String((body.data && body.data.id) || query['data.id'] || (type === 'payment' && (query.id || body.id)) || '');
    if (type === 'payment' && /^\d{1,20}$/.test(id)) {
      try { await applyPayment(await mp('GET', '/v1/payments/' + id)); }
      catch (e) {
        // Pagamento inexistente (ex.: o teste do painel do Mercado Pago): nada a fazer.
        if (e.status === 404) return send(res, 200, { ok: true });
        console.error(e); return send(res, 500, { error: 'tente de novo' });   // 500 faz o Mercado Pago tentar de novo
      }
    }
    return send(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/booking\/([a-f0-9]{32})\/paid$/)) && method === 'POST') {
    const b = await getBooking(m[1]);
    if (!b) return send(res, 404, { error: 'Agendamento não encontrado.' });
    if (b.checkoutUrl) return send(res, 200, publicBooking(b));   // pelo Mercado Pago a confirmação é automática
    if (b.status === 'pending') {
      const expired = Date.now() >= b.expiresAt;
      if (expired || !(await claimSlot(b))) return send(res, 410, { error: 'O tempo para pagamento acabou. Escolha o horário novamente.' });
      b.status = 'paid_claimed'; b.claimedAt = Date.now();
      await saveBooking(b);
    }
    return send(res, 200, publicBooking(b));
  }

  // ----- Painel do dono -----
  if (p.startsWith('/admin/')) {
    const ip = clientIp(req);
    const fails = +(await redis('GET', 'fail:' + ip)) || 0;
    if (fails >= 8) return send(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos.' });
    if (!adminOk(req)) {
      await redisPipe([['INCR', 'fail:' + ip], ['EXPIRE', 'fail:' + ip, 600, 'NX']]);
      return send(res, 401, { error: 'Senha incorreta.' });
    }

    if (method === 'GET' && p === '/admin/overview') {
      const today = nowSP().date;
      const ids = await redis('SMEMBERS', 'ids');
      let recs = [];
      if (ids.length) {
        const vals = await redis('MGET', ...ids.map(i => 'b:' + i));
        const stale = [];
        vals.forEach((v, i) => { if (v) recs.push(JSON.parse(v)); else stale.push(ids[i]); });
        if (stale.length) await redis('SREM', 'ids', ...stale);
      }
      const bookings = recs
        .filter(b => b.date >= today && !['cancelled', 'refunded'].includes(b.status) && (b.status !== 'pending' || Date.now() < b.expiresAt))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map(b => ({ id: b.id, name: b.name, phone: b.phone, date: b.date, time: b.time, status: b.status, mp: !!b.checkoutUrl }));
      const all = await redis('SMEMBERS', 'blocks');
      const old = all.filter(s => s.split('|')[0] < today);
      if (old.length) await redis('SREM', 'blocks', ...old);
      const blocks = all.filter(s => s.split('|')[0] >= today).sort()
        .map(s => { const [date, time] = s.split('|'); return { date, time: time || null }; });
      return send(res, 200, { bookings, blocks, slots: SLOTS, days: openDays() });
    }
    if ((m = p.match(/^\/admin\/booking\/([a-f0-9]{32})\/(confirm|cancel)$/)) && method === 'POST') {
      const b = await getBooking(m[1]);
      if (!b) return send(res, 404, { error: 'Não encontrado.' });
      if (m[2] === 'confirm') {
        if (b.status === 'cancelled') return send(res, 409, { error: 'Este agendamento foi cancelado.' });
        if (!(await claimSlot(b))) return send(res, 409, { error: 'O tempo dessa reserva acabou e o horário foi liberado. Peça para o cliente agendar de novo.' });
        b.status = 'confirmed';
      } else {
        await releaseSlot(b);
        b.status = 'cancelled';
      }
      await saveBooking(b);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/admin/reset-code') {
      const digits = normPhone((await readJson()).phone);
      const user = validPhone(digits) && await getUser(digits);
      if (!user) return send(res, 404, { error: 'Nenhuma conta com esse WhatsApp.' });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await redisPipe([['SET', 'reset:' + digits, sha(digits + ':' + code), 'EX', RESET_TTL], ['DEL', 'rfail:' + digits]]);
      return send(res, 200, { code, name: user.name, phone: digits, minutes: RESET_TTL / 60 });
    }
    if (method === 'POST' && (p === '/admin/block' || p === '/admin/unblock')) {
      const { date, time } = await readJson();
      if (!validDate(date) || (time !== null && time !== undefined && time !== '' && !SLOTS.includes(time))) return send(res, 400, { error: 'Dados inválidos.' });
      await redis(p === '/admin/block' ? 'SADD' : 'SREM', 'blocks', `${date}|${time || ''}`);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Não encontrado.' });
}

module.exports = async (req, res) => {
  try {
    if (!REDIS_URL || !REDIS_TOKEN) return send(res, 503, { error: 'Banco de dados não configurado.' });
    const url = new URL(req.url, 'http://localhost');
    let p = req.query && req.query.path !== undefined ? req.query.path : url.searchParams.get('path');
    if (Array.isArray(p)) p = p.join('/');
    if (!p) p = url.pathname.replace(/^\/api\/?/, '');
    p = '/' + String(p).replace(/^\/+|\/+$/g, '');
    const q = k => (req.query && req.query[k]) || url.searchParams.get(k);
    const query = { date: q('date'), type: q('type'), topic: q('topic'), id: q('id'), 'data.id': q('data.id') };
    return await route(req, res, p, query, () => readBody(req));
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Algo deu errado. Tente novamente em instantes.' });
  }
};
