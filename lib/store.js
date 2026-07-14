// ============================================================================
//  Camada de dados — Upstash Redis (via API REST, sem dependências externas).
//  Guarda colaboradores, pontos, conversas, comprovantes e prêmios.
// ============================================================================
import crypto from 'node:crypto';

const URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const dbReady = Boolean(URL && TOKEN);

async function call(body, path = '') {
  if (!dbReady) throw new Error('Banco de dados não configurado. Instale o Upstash Redis na Vercel.');
  const r = await fetch(URL + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Falha no banco de dados (' + r.status + ')');
  return r.json();
}

export async function cmd(command) {
  const j = await call(command);
  return j.result;
}
export async function pipeline(commands) {
  const j = await call(commands, '/pipeline');
  return Array.isArray(j) ? j.map(x => x.result) : [];
}

/* ---------- JSON helpers ---------- */
export async function getJSON(key) {
  const raw = await cmd(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export async function setJSON(key, value) {
  return cmd(['SET', key, JSON.stringify(value)]);
}

/* ---------- Senhas / PIN ---------- */
export function hashPin(pin, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), s, 32).toString('hex');
  return { salt: s, hash: h };
}
export function checkPin(pin, salt, hash) {
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}

/* ---------- Sessões ---------- */
const SESSION_TTL = 60 * 60 * 12; // 12 horas

export async function createSession(matricula) {
  const token = crypto.randomBytes(24).toString('hex');
  await cmd(['SETEX', `sess:${token}`, String(SESSION_TTL), matricula]);
  return token;
}
export async function sessionUser(req) {
  const token = req.headers['x-session'];
  if (!token) return null;
  const matricula = await cmd(['GET', `sess:${token}`]);
  if (!matricula) return null;
  return getUser(matricula);
}

/* ---------- Colaboradores ---------- */
export function userKey(matricula) { return `user:${String(matricula).trim()}`; }

export async function getUser(matricula) {
  return getJSON(userKey(matricula));
}
export async function saveUser(user) {
  await pipeline([
    ['SET', userKey(user.matricula), JSON.stringify(user)],
    ['SADD', 'idx:users', user.matricula],
  ]);
  return user;
}
export async function listUsers() {
  const ids = await cmd(['SMEMBERS', 'idx:users']);
  if (!ids || !ids.length) return [];
  const rows = await cmd(['MGET', ...ids.map(userKey)]);
  return (rows || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

export function newUser(matricula, nome, pin) {
  const { salt, hash } = hashPin(pin);
  return {
    matricula: String(matricula).trim(),
    nome: String(nome || '').trim(),
    salt, hash,
    points: 0,
    done: {},        // { missionId: vezes concluídas }
    streak: 0,       // check-ins seguidos
    lastCheckin: null,
    rhValidado: false,
    createdAt: Date.now(),
  };
}

/* ---------- Conversas ---------- */
export async function saveConversation(matricula, messages) {
  const now = Date.now();
  await pipeline([
    ['SET', `conv:${matricula}`, JSON.stringify({ matricula, updatedAt: now, messages })],
    ['ZADD', 'idx:conversations', String(now), matricula],
  ]);
}
export async function getConversation(matricula) {
  return getJSON(`conv:${matricula}`);
}

/* ---------- Submissões (missões enviadas) ---------- */
export async function saveSubmission(sub) {
  await pipeline([
    ['SET', `sub:${sub.id}`, JSON.stringify(sub)],
    ['ZADD', 'idx:subs', String(sub.createdAt), sub.id],
    ['ZADD', `idx:subs:${sub.matricula}`, String(sub.createdAt), sub.id],
  ]);
  return sub;
}
export async function getSubmission(id) { return getJSON(`sub:${id}`); }

export async function listSubmissions({ matricula, limit = 200 } = {}) {
  const key = matricula ? `idx:subs:${matricula}` : 'idx:subs';
  const ids = await cmd(['ZREVRANGE', key, '0', String(limit - 1)]);
  if (!ids || !ids.length) return [];
  const rows = await cmd(['MGET', ...ids.map(i => `sub:${i}`)]);
  return (rows || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

/* ---------- Comprovantes (arquivos) ---------- */
// A imagem é comprimida no navegador antes de subir; guardamos o dataURL.
export async function saveFile(id, dataUrl) {
  return cmd(['SET', `file:${id}`, dataUrl]);
}
export async function getFile(id) {
  return cmd(['GET', `file:${id}`]);
}

/* ---------- Prêmios ---------- */
export async function getPrizes() {
  const p = await getJSON('prizes');
  return Array.isArray(p) ? p : [];
}
export async function setPrizes(list) {
  return setJSON('prizes', list);
}
