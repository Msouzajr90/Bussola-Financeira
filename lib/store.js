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

// Quantos colaboradores já começaram (para o senso de pertencimento).
export async function countUsers() {
  const n = await cmd(['SCARD', 'idx:users']);
  return Number(n) || 0;
}

// O gestor reseta o PIN: o colaborador cria um novo no próximo acesso.
export async function resetPin(matricula) {
  const u = await getUser(matricula);
  if (!u) return null;
  u.salt = null;
  u.hash = null;
  u.mustResetPin = true;
  u.failedAttempts = 0;
  u.lockedUntil = 0;
  await saveUser(u);
  return u;
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
    perfil: null,       // { nascimento, casado, filhos }
    foto: null,         // avatar (base64) opcional
    modules: {},        // { trilhaId: true } — módulos liberados (além dos base)
    moduleSug: [],      // módulos sugeridos pelo diagnóstico, aguardando o gestor
    dividas: [],        // lista de dívidas cadastradas
    orcamentos: [],     // histórico mensal { mes, tipo, renda, categorias }
    patrimonio: [],     // bens cadastrados
    planoQuitacao: null,// plano publicado pelo gestor
    moduleBonus: {},    // bônus de módulo já creditados
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

// Remove um envio (usado ao excluir um objetivo).
export async function deleteSubmission(sub) {
  await pipeline([
    ['DEL', `sub:${sub.id}`],
    ['ZREM', 'idx:subs', sub.id],
    ['ZREM', `idx:subs:${sub.matricula}`, sub.id],
  ]);
}

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

/* ---------- Configuração de módulos (pontos de bônus por módulo) ---------- */
export async function getModuleConfig() {
  const c = await getJSON('cfg:modules');
  return c && typeof c === 'object' ? c : {};
}
export async function setModuleConfig(cfg) {
  return setJSON('cfg:modules', cfg || {});
}

/* ---------- Novidades (mural de avisos) ---------- */
export async function getNews() {
  const n = await getJSON('news');
  return Array.isArray(n) ? n : [];
}
export async function setNews(list) {
  return setJSON('news', Array.isArray(list) ? list.slice(0, 100) : []);
}

/* ---------- Backup completo do banco (dump de TODAS as chaves) ---------- */
// Percorre todo o banco com SCAN e lê cada chave conforme o seu tipo.
// Inclui credenciais (hash do PIN) — é um backup para restauração, guarde com cuidado.
// Ignora sessões (efêmeras) e os próprios backups (para não aninhar cópias).
const BACKUP_SKIP = k => k.startsWith('sess:') || k.startsWith('backup:') || k === 'idx:backups';

export async function dumpAll() {
  const dump = {};
  let cursor = '0';
  const keys = [];
  do {
    const [next, batch] = await cmd(['SCAN', cursor, 'COUNT', '200']);
    cursor = next;
    if (Array.isArray(batch)) keys.push(...batch);
  } while (cursor !== '0');

  for (const key of keys) {
    if (BACKUP_SKIP(key)) continue;
    const type = await cmd(['TYPE', key]);
    let value;
    if (type === 'string') value = await cmd(['GET', key]);
    else if (type === 'set') value = await cmd(['SMEMBERS', key]);
    else if (type === 'zset') value = await cmd(['ZRANGE', key, '0', '-1', 'WITHSCORES']);
    else if (type === 'list') value = await cmd(['LRANGE', key, '0', '-1']);
    else if (type === 'hash') value = await cmd(['HGETALL', key]);
    else value = null;
    dump[key] = { type, value };
  }
  return { exportadoEm: Date.now(), totalChaves: Object.keys(dump).length, dados: dump };
}

// Reescreve o banco a partir de um dump (sobrescrever por cima).
// Chaves existentes que não estão no dump permanecem intactas.
export async function restoreDump(dump) {
  const dados = (dump && dump.dados) ? dump.dados : dump;
  if (!dados || typeof dados !== 'object') throw new Error('Arquivo de backup inválido.');
  let n = 0;
  for (const [key, entry] of Object.entries(dados)) {
    if (BACKUP_SKIP(key)) continue;
    const type = entry && entry.type;
    const value = entry && entry.value;
    try {
      if (type === 'string') {
        if (value != null) await cmd(['SET', key, value]);
      } else if (type === 'set') {
        await cmd(['DEL', key]);
        if (Array.isArray(value) && value.length) await cmd(['SADD', key, ...value]);
      } else if (type === 'zset') {
        await cmd(['DEL', key]);
        // value = [member, score, member, score, ...]
        if (Array.isArray(value) && value.length) {
          const args = [];
          for (let i = 0; i < value.length; i += 2) args.push(value[i + 1], value[i]); // score, member
          if (args.length) await cmd(['ZADD', key, ...args]);
        }
      } else if (type === 'list') {
        await cmd(['DEL', key]);
        if (Array.isArray(value) && value.length) await cmd(['RPUSH', key, ...value]);
      } else if (type === 'hash') {
        await cmd(['DEL', key]);
        const flat = Array.isArray(value) ? value : Object.entries(value || {}).flat();
        if (flat.length) await cmd(['HSET', key, ...flat]);
      }
      n++;
    } catch (_) { /* segue para a próxima chave */ }
  }
  return { restauradas: n };
}

/* ---------- Snapshots diários (últimos 7 dias, dentro do Redis) ---------- */
const BACKUP_KEEP = 7;

export async function saveBackupSnapshot() {
  const dump = await dumpAll();
  const dia = new Date().toISOString().slice(0, 10); // AAAA-MM-DD
  const key = `backup:${dia}`;
  await cmd(['SET', key, JSON.stringify(dump)]);
  await cmd(['ZADD', 'idx:backups', String(Date.now()), key]);
  // Mantém só os últimos BACKUP_KEEP.
  const todos = await cmd(['ZRANGE', 'idx:backups', '0', '-1']);
  if (Array.isArray(todos) && todos.length > BACKUP_KEEP) {
    const excedentes = todos.slice(0, todos.length - BACKUP_KEEP);
    for (const k of excedentes) {
      await cmd(['DEL', k]);
      await cmd(['ZREM', 'idx:backups', k]);
    }
  }
  return { dia, key, totalChaves: dump.totalChaves };
}

export async function listBackups() {
  const keys = await cmd(['ZREVRANGE', 'idx:backups', '0', '-1']);
  if (!Array.isArray(keys) || !keys.length) return [];
  const out = [];
  for (const k of keys) {
    const raw = await cmd(['GET', k]);
    let meta = { exportadoEm: null, totalChaves: null };
    if (raw) { try { const d = JSON.parse(raw); meta = { exportadoEm: d.exportadoEm, totalChaves: d.totalChaves }; } catch (_) {} }
    out.push({ key: k, dia: k.replace('backup:', ''), tamanho: raw ? raw.length : 0, ...meta });
  }
  return out;
}

export async function getBackup(key) {
  if (!key || !String(key).startsWith('backup:')) return null;
  const raw = await cmd(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/* ---------- Excluir um colaborador integralmente ---------- */
export async function deleteUserFully(matricula) {
  const m = String(matricula).trim();
  const u = await getUser(m);
  if (!u) return { ok: false, motivo: 'Colaborador não encontrado.' };

  // Envios do colaborador (e arquivos anexados)
  const ids = await cmd(['ZRANGE', `idx:subs:${m}`, '0', '-1']);
  if (Array.isArray(ids)) {
    for (const id of ids) {
      const sub = await getJSON(`sub:${id}`);
      if (sub && sub.fileId) await cmd(['DEL', `file:${sub.fileId}`]);
      await cmd(['DEL', `sub:${id}`]);
      await cmd(['ZREM', 'idx:subs', id]);
    }
  }
  await cmd(['DEL', `idx:subs:${m}`]);
  await cmd(['DEL', `conv:${m}`]);
  await cmd(['DEL', `user:${m}`]);
  await cmd(['SREM', 'idx:users', m]);
  return { ok: true, enviosRemovidos: Array.isArray(ids) ? ids.length : 0 };
}

/* ---------- Prêmios ---------- */
export async function getPrizes() {
  const p = await getJSON('prizes');
  return Array.isArray(p) ? p : [];
}
export async function setPrizes(list) {
  return setJSON('prizes', list);
}

/* ---------- Missões personalizadas (criadas pelo gestor) ---------- */
// Cada uma vale só para os colaboradores escolhidos (campo `assignees`).
export async function listCustomMissions() {
  const ids = await cmd(['SMEMBERS', 'idx:custom']);
  if (!ids || !ids.length) return [];
  const rows = await cmd(['MGET', ...ids.map(i => `custom:${i}`)]);
  return (rows || [])
    .map(r => { try { return JSON.parse(r); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}
export async function saveCustomMission(m) {
  await pipeline([
    ['SET', `custom:${m.id}`, JSON.stringify(m)],
    ['SADD', 'idx:custom', m.id],
  ]);
  return m;
}
export async function deleteCustomMission(id) {
  await pipeline([
    ['DEL', `custom:${id}`],
    ['SREM', 'idx:custom', id],
  ]);
}
// Missões personalizadas atribuídas a um colaborador.
export async function customFor(matricula) {
  const all = await listCustomMissions();
  return all.filter(m => m.ativo !== false && (m.assignees || []).includes(String(matricula)));
}

/* ---------- Aulas (área educacional / vídeos do YouTube) ---------- */
export async function listLessons() {
  const ids = await cmd(['SMEMBERS', 'idx:lessons']);
  if (!ids || !ids.length) return [];
  const rows = await cmd(['MGET', ...ids.map(i => `lesson:${i}`)]);
  return (rows || [])
    .map(r => { try { return JSON.parse(r); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.ordem - b.ordem) || (a.createdAt - b.createdAt));
}
export async function getLesson(id) { return getJSON(`lesson:${id}`); }
export async function saveLesson(lesson) {
  await pipeline([
    ['SET', `lesson:${lesson.id}`, JSON.stringify(lesson)],
    ['SADD', 'idx:lessons', lesson.id],
  ]);
  return lesson;
}
export async function deleteLesson(id) {
  await pipeline([
    ['DEL', `lesson:${id}`],
    ['SREM', 'idx:lessons', id],
  ]);
}
