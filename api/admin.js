// ============================================================================
//  Painel do gestor — protegido pela senha ADMIN_PASSWORD (cabeçalho x-admin-key).
//
//    GET  ?action=overview            → ranking individual + resumo
//    GET  ?action=conversation&m=123  → conversa de um colaborador
//    GET  ?action=submissions         → missões enviadas (fila de aprovação)
//    GET  ?action=file&id=...         → comprovante enviado
//    GET  ?action=prizes              → prêmios cadastrados
//    POST ?action=review              → aprovar/recusar um comprovante
//    POST ?action=prizes              → salvar os prêmios
//    POST ?action=rh                  → marcar validação do RH (folha)
// ============================================================================
import {
  listUsers, getUser, saveUser, getConversation,
  listSubmissions, getSubmission, saveSubmission, getFile,
  getPrizes, setPrizes, dbReady,
} from '../lib/store.js';
import { levelFor, findMission, LEVELS } from '../lib/missions.js';

function authorized(req) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return false;
  const given = req.headers['x-admin-key'] || (req.query && req.query.key);
  return given === pass;
}

export default async function handler(req, res) {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Defina ADMIN_PASSWORD nas variáveis de ambiente da Vercel.' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'Senha incorreta.' });
  if (!dbReady) return res.status(500).json({ error: 'Banco de dados não configurado.' });

  const action = (req.query && req.query.action) || '';

  try {
    /* ------------------------- LEITURA ------------------------- */
    if (req.method === 'GET') {

      if (action === 'overview') {
        const users = await listUsers();
        const subs = await listSubmissions({ limit: 300 });
        const pendentes = subs.filter(s => s.status === 'pendente').length;

        const ranking = users
          .map(u => ({
            matricula: u.matricula,
            nome: u.nome,
            points: u.points || 0,
            level: levelFor(u.points || 0),
            missoes: Object.values(u.done || {}).reduce((a, b) => a + b, 0),
            streak: u.streak || 0,
            rhValidado: !!u.rhValidado,
            createdAt: u.createdAt,
          }))
          .sort((a, b) => b.points - a.points);

        const porNivel = LEVELS.map(l => ({
          level: l.level,
          name: l.name,
          total: ranking.filter(r => r.level.level === l.level).length,
        }));

        return res.status(200).json({
          ranking,
          resumo: {
            colaboradores: ranking.length,
            pontosTotais: ranking.reduce((a, r) => a + r.points, 0),
            comprovantesPendentes: pendentes,
            porNivel,
          },
        });
      }

      if (action === 'conversation') {
        const m = req.query.m;
        const conv = await getConversation(m);
        if (!conv) return res.status(404).json({ error: 'Sem conversa registrada.' });
        return res.status(200).json({ conversation: conv });
      }

      if (action === 'submissions') {
        const subs = await listSubmissions({ limit: 300 });
        return res.status(200).json({ submissions: subs });
      }

      if (action === 'file') {
        const data = await getFile(req.query.id);
        if (!data) return res.status(404).json({ error: 'Comprovante não encontrado.' });
        return res.status(200).json({ file: data });
      }

      if (action === 'prizes') {
        return res.status(200).json({ prizes: await getPrizes() });
      }

      return res.status(400).json({ error: 'Ação inválida.' });
    }

    /* ------------------------- ESCRITA ------------------------- */
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

      // Aprovar ou recusar um comprovante
      if (action === 'review') {
        const sub = await getSubmission(body.id);
        if (!sub) return res.status(404).json({ error: 'Envio não encontrado.' });
        if (sub.status !== 'pendente') return res.status(409).json({ error: 'Este envio já foi avaliado.' });

        const aprovar = body.decision === 'aprovar';
        sub.status = aprovar ? 'aprovado' : 'recusado';
        sub.note = String(body.note || '');
        sub.reviewedAt = Date.now();

        if (aprovar) {
          const found = findMission(sub.missionId);
          const pontos = found ? found.mission.points : 0;
          const user = await getUser(sub.matricula);
          if (user) {
            user.points = (user.points || 0) + pontos;
            user.done = { ...(user.done || {}), [sub.missionId]: ((user.done || {})[sub.missionId] || 0) + 1 };
            await saveUser(user);
          }
          sub.points = pontos;
        }

        await saveSubmission(sub);
        return res.status(200).json({ ok: true, submission: sub });
      }

      // Cadastro de prêmios (um por nível; valores em aberto)
      if (action === 'prizes') {
        const list = Array.isArray(body.prizes) ? body.prizes : [];
        const clean = list
          .filter(p => p && typeof p.level === 'number')
          .map(p => ({
            level: p.level,
            titulo: String(p.titulo || '').slice(0, 120),
            descricao: String(p.descricao || '').slice(0, 400),
            ativo: p.ativo !== false,
          }));
        await setPrizes(clean);
        return res.status(200).json({ ok: true, prizes: clean });
      }

      // Validação pelo RH (folha de pagamento) — gancho para uso futuro
      if (action === 'rh') {
        const user = await getUser(body.matricula);
        if (!user) return res.status(404).json({ error: 'Colaborador não encontrado.' });
        user.rhValidado = !!body.validado;
        await saveUser(user);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Ação inválida.' });
    }

    return res.status(405).json({ error: 'Método não permitido.' });
  } catch (err) {
    console.error('admin:', err);
    return res.status(500).json({ error: 'Erro no painel do gestor.' });
  }
}
