// ============================================================================
//  Cadastro e login do colaborador — matrícula + PIN.
//  POST { action: 'register'|'login', matricula, nome?, pin }
// ============================================================================
import { getUser, newUser, saveUser, checkPin, createSession, dbReady } from '../lib/store.js';
import { levelFor } from '../lib/missions.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!dbReady) return res.status(500).json({ error: 'Banco de dados não configurado. Instale o Upstash Redis na Vercel.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const action = body.action;
    const matricula = String(body.matricula || '').trim();
    const pin = String(body.pin || '').trim();

    if (!matricula) return res.status(400).json({ error: 'Informe sua matrícula.' });
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'O PIN deve ter de 4 a 8 números.' });

    if (action === 'register') {
      const nome = String(body.nome || '').trim();
      if (!nome) return res.status(400).json({ error: 'Informe seu nome.' });

      const existing = await getUser(matricula);
      if (existing) return res.status(409).json({ error: 'Esta matrícula já tem cadastro. Faça login com seu PIN.' });

      const user = newUser(matricula, nome, pin);
      await saveUser(user);
      const token = await createSession(matricula);
      return res.status(200).json({ token, user: publicUser(user) });
    }

    if (action === 'login') {
      const user = await getUser(matricula);
      if (!user) return res.status(404).json({ error: 'Matrícula não encontrada. Faça seu primeiro acesso.' });

      let ok = false;
      try { ok = checkPin(pin, user.salt, user.hash); } catch { ok = false; }
      if (!ok) return res.status(401).json({ error: 'PIN incorreto.' });

      const token = await createSession(matricula);
      return res.status(200).json({ token, user: publicUser(user) });
    }

    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (err) {
    console.error('auth:', err);
    return res.status(500).json({ error: 'Erro ao processar o acesso.' });
  }
}

export function publicUser(u) {
  return {
    matricula: u.matricula,
    nome: u.nome,
    points: u.points || 0,
    done: u.done || {},
    lessonsDone: u.lessonsDone || {},
    streak: u.streak || 0,
    level: levelFor(u.points || 0),
  };
}
