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
const DEPOSIT = '20.00';                                         // valor do sinal
const HOLD_MIN = +process.env.HOLD_MIN || 15;                    // minutos que o horário fica reservado aguardando o Pix
const HOLD_GRACE_MS = 10000;                                     // folga para o relógio do banco não vencer antes do nosso
const MAX_DAYS_AHEAD = 21;
const TZ = 'America/Sao_Paulo';
// Segunda a sábado, blocos de 1h30, do primeiro às 10:00 até o último às 20:30 (termina 22:00)
const SLOTS = ['10:00', '11:30', '13:00', '14:30', '16:00', '17:30', '19:00', '20:30'];
const BOOKING_TTL = 60 * 24 * 3600;   // registros somem sozinhos após 60 dias
const SLOT_TTL = 45 * 24 * 3600;

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
const claimSlot = async b => (await redis('EVAL', LUA_CLAIM, 1, slotKey(b.date, b.time), b.id, SLOT_TTL)) === 1;
const releaseSlot = b => redis('EVAL', LUA_RELEASE, 1, slotKey(b.date, b.time), b.id);

async function getBooking(id) {
  const raw = await redis('GET', 'b:' + id);
  return raw ? JSON.parse(raw) : null;
}
const saveBooking = b => redis('SET', 'b:' + b.id, JSON.stringify(b), 'EX', BOOKING_TTL);

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
  const [taken, blocks] = await redisPipe([['MGET', ...SLOTS.map(t => slotKey(date, t))], ['SMEMBERS', 'blocks']]);
  const wholeDay = blocks.includes(date + '|');
  return SLOTS.map((time, i) => ({
    time,
    status: isPast(date, time) ? 'past' : (wholeDay || blocks.includes(`${date}|${time}`)) ? 'blocked' : taken[i] ? 'taken' : 'free'
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
  return {
    id: b.id, name: b.name, date: b.date, time: b.time, status, expiresAt: b.expiresAt,
    pix: { payload: pixPayload(), key: PIX_KEY, name: PIX_NAME, amount: DEPOSIT }
  };
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
    return send(res, 200, { name: 'Thiago Barbearia', deposit: DEPOSIT, holdMin: HOLD_MIN, days: openDays(), pixConfigured: !!PIX_KEY });
  }

  if (method === 'GET' && p === '/slots') {
    const date = query.date;
    if (!validDate(date) || weekday(date) === 0 || !openDays().includes(date)) return send(res, 400, { error: 'Data indisponível.' });
    return send(res, 200, await dayStatus(date));
  }

  if (method === 'POST' && p === '/book') {
    if (!PIX_KEY) return send(res, 503, { error: 'Pagamento ainda não configurado.' });
    const { name, phone, date, time } = await readJson();
    const cleanName = String(name || '').trim().slice(0, 60);
    const digits = String(phone || '').replace(/\D/g, '');
    if (cleanName.length < 2) return send(res, 400, { error: 'Informe seu nome.' });
    if (digits.length < 10 || digits.length > 13) return send(res, 400, { error: 'Informe um WhatsApp válido com DDD.' });
    if (!validDate(date) || !SLOTS.includes(time) || !openDays().includes(date)) return send(res, 400, { error: 'Horário inválido.' });
    const current = (await dayStatus(date)).find(s => s.time === time);
    if (current.status !== 'free') return send(res, 409, { error: 'Esse horário acabou de ser ocupado. Escolha outro.' });

    const b = {
      id: crypto.randomBytes(16).toString('hex'), name: cleanName, phone: digits, date, time,
      status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + HOLD_MIN * 60 * 1000
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
    await redisPipe([['SET', 'b:' + b.id, JSON.stringify(b), 'EX', BOOKING_TTL], ['SADD', 'ids', b.id]]);
    return send(res, 201, publicBooking(b));
  }

  let m;
  if ((m = p.match(/^\/booking\/([a-f0-9]{32})$/)) && method === 'GET') {
    const b = await getBooking(m[1]);
    return b ? send(res, 200, publicBooking(b)) : send(res, 404, { error: 'Agendamento não encontrado.' });
  }
  if ((m = p.match(/^\/booking\/([a-f0-9]{32})\/paid$/)) && method === 'POST') {
    const b = await getBooking(m[1]);
    if (!b) return send(res, 404, { error: 'Agendamento não encontrado.' });
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
        .filter(b => b.date >= today && b.status !== 'cancelled' && (b.status !== 'pending' || Date.now() < b.expiresAt))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map(b => ({ id: b.id, name: b.name, phone: b.phone, date: b.date, time: b.time, status: b.status }));
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
    const query = { date: (req.query && req.query.date) || url.searchParams.get('date') };
    return await route(req, res, p, query, () => readBody(req));
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Algo deu errado. Tente novamente em instantes.' });
  }
};
