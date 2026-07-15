// ============================================================================
//  Cadastro e login do colaborador — matrícula + PIN.
//  POST { action: 'register'|'login'|'setpin', matricula, nome?, pin }
//
//  Segurança:
//   - Bloqueio temporário após 5 PINs errados (evita adivinhação).
//   - 'setpin' cria um novo PIN quando o gestor resetou o acesso.
// ============================================================================
import { getUser, newUser, saveUser, checkPin, hashPin, createSession, dbReady } from '../lib/store.js';
import { publicUser } from '../lib/missions.js';

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!dbReady) return res.status(500).json({ error: 'Banco de dados não configurado. Instale o Upstash Redis na Vercel.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const action = body.action;
    const matricula = String(body.matricula || '').trim();
    const pin = String(body.pin || '').trim();

    if (!matricula) return res.status(400).json({ error: 'Informe sua matrícula.' });
    if (action !== 'login' && !/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ error: 'O PIN deve ter de 4 a 8 números.' });
    }

    /* ---------------- Primeiro acesso ---------------- */
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

    /* ---------------- Criar novo PIN (após reset do gestor) ---------------- */
    if (action === 'setpin') {
      const user = await getUser(matricula);
      if (!user) return res.status(404).json({ error: 'Matrícula não encontrada.' });
      if (!user.mustResetPin) return res.status(400).json({ error: 'Este acesso não está aguardando novo PIN. Faça login normalmente.' });
      if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'O PIN deve ter de 4 a 8 números.' });

      const { salt, hash } = hashPin(pin);
      user.salt = salt; user.hash = hash;
      user.mustResetPin = false;
      user.failedAttempts = 0;
      user.lockedUntil = 0;
      await saveUser(user);
      const token = await createSession(matricula);
      return res.status(200).json({ token, user: publicUser(user) });
    }

    /* ---------------- Login ---------------- */
    if (action === 'login') {
      const user = await getUser(matricula);
      if (!user) return res.status(404).json({ error: 'Matrícula não encontrada. Faça seu primeiro acesso.' });

      // O gestor resetou: pede um novo PIN.
      if (user.mustResetPin) {
        return res.status(200).json({ needsNewPin: true, message: 'Seu PIN foi redefinido pelo gestor. Crie um novo PIN.' });
      }

      // Bloqueio ativo?
      const now = Date.now();
      if (user.lockedUntil && user.lockedUntil > now) {
        const min = Math.ceil((user.lockedUntil - now) / 60000);
        return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em ' + min + ' minuto(s) ou peca ao gestor para redefinir seu PIN.' });
      }

      if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'Informe seu PIN.' });

      let ok = false;
      try { ok = checkPin(pin, user.salt, user.hash); } catch { ok = false; }

      if (!ok) {
        user.failedAttempts = (user.failedAttempts || 0) + 1;
        let msg;
        if (user.failedAttempts >= MAX_ATTEMPTS) {
          user.lockedUntil = now + LOCK_MINUTES * 60000;
          user.failedAttempts = 0;
          msg = 'Muitas tentativas. Acesso bloqueado por ' + LOCK_MINUTES + ' minutos. Se esqueceu o PIN, peca ao gestor para redefinir.';
        } else {
          const restam = MAX_ATTEMPTS - user.failedAttempts;
          msg = 'PIN incorreto. Voce tem mais ' + restam + ' tentativa(s) antes do bloqueio.';
        }
        await saveUser(user);
        return res.status(401).json({ error: msg });
      }

      // Sucesso: zera o contador
      if (user.failedAttempts || user.lockedUntil) {
        user.failedAttempts = 0;
        user.lockedUntil = 0;
        await saveUser(user);
      }
      const token = await createSession(matricula);
      return res.status(200).json({ token, user: publicUser(user) });
    }

    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (err) {
    console.error('auth:', err);
    return res.status(500).json({ error: 'Erro ao processar o acesso.' });
  }
}
