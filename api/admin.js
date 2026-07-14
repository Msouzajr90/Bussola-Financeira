// ============================================================================
//  Painel do gestor — protegido pela senha ADMIN_PASSWORD (cabeçalho x-admin-key).
//
//    GET  ?action=dashboard           → indicadores do programa
//    GET  ?action=overview            → ranking individual
//    GET  ?action=user&m=123          → ficha completa de um colaborador
//    GET  ?action=conversation&m=123  → conversa de um colaborador
//    GET  ?action=submissions         → todos os envios (fila de aprovação)
//    GET  ?action=files               → pasta de documentos enviados
//    GET  ?action=file&id=...         → conteúdo de um documento
//    GET  ?action=prizes              → prêmios cadastrados
//    POST ?action=review              → aprovar/recusar um comprovante
//    POST ?action=prizes              → salvar os prêmios
//    POST ?action=rh                  → marcar validação do RH (folha)
// ============================================================================
import crypto from 'node:crypto';
import {
  listUsers, getUser, saveUser, getConversation,
  listSubmissions, getSubmission, saveSubmission, getFile,
  getPrizes, setPrizes, dbReady,
  listCustomMissions, saveCustomMission, deleteCustomMission,
} from '../lib/store.js';
import { levelFor, findMission, LEVELS, TRACKS } from '../lib/missions.js';

function authorized(req) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return false;
  const given = req.headers['x-admin-key'] || (req.query && req.query.key);
  return given === pass;
}

// Descobre o tipo do arquivo pelo início do dataURL guardado na submissão.
function mimeOf(sub) {
  return sub.fileMime || 'image/jpeg';
}

export default async function handler(req, res) {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Defina ADMIN_PASSWORD nas variáveis de ambiente da Vercel.' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'Senha incorreta.' });
  if (!dbReady) return res.status(500).json({ error: 'Banco de dados não configurado.' });

  const action = (req.query && req.query.action) || '';

  try {
    /* ========================== LEITURA ========================== */
    if (req.method === 'GET') {

      /* ---------- Dashboard ---------- */
      if (action === 'dashboard') {
        const [users, subs] = await Promise.all([
          listUsers(),
          listSubmissions({ limit: 1000 }),
        ]);

        const aprovados = subs.filter(s => s.status === 'aprovado');
        const pendentes = subs.filter(s => s.status === 'pendente');
        const recusados = subs.filter(s => s.status === 'recusado');

        const total = users.length;
        const pontosTotais = users.reduce((a, u) => a + (u.points || 0), 0);
        const ativos = users.filter(u => Object.keys(u.done || {}).length > 0).length;

        // Distribuição por nível
        const porNivel = LEVELS.map(l => {
          const qtd = users.filter(u => levelFor(u.points || 0).level === l.level).length;
          return { level: l.level, name: l.name, total: qtd, pct: total ? Math.round(qtd / total * 100) : 0 };
        });

        // Conclusão por missão e por trilha
        const trilhas = TRACKS.map(t => {
          const missoes = t.missions.map(m => {
            const feitos = users.filter(u => (u.done || {})[m.id]).length;
            return {
              id: m.id, title: m.title, points: m.points, type: m.type,
              repeatable: !!m.repeatable,
              concluiram: feitos,
              pct: total ? Math.round(feitos / total * 100) : 0,
              vezes: aprovados.filter(s => s.missionId === m.id).length,
            };
          });
          const media = missoes.length
            ? Math.round(missoes.reduce((a, m) => a + m.pct, 0) / missoes.length) : 0;
          return { id: t.id, name: t.name, missoes, pct: media };
        });

        // Conquistas de impacto real
        const conta = id => aprovados.filter(s => s.missionId === id).length;
        const conquistas = {
          dividasQuitadas: conta('div_quitada'),
          reservasMantidas: conta('res_manter'),
          objetivosAlcancados: conta('obj_atingir'),
          orcamentosMontados: conta('orc_montar'),
          planosQuitacao: conta('div_plano'),
          registratos: conta('diag_registrato'),
          checkins: conta('hab_checkin'),
        };

        // Engajamento
        const streaks = users.map(u => u.streak || 0);
        const engajamento = {
          ativos,
          inativos: total - ativos,
          taxaAtivos: total ? Math.round(ativos / total * 100) : 0,
          mediaPontos: total ? Math.round(pontosTotais / total) : 0,
          maiorSequencia: streaks.length ? Math.max(...streaks) : 0,
          comSequencia: users.filter(u => (u.streak || 0) >= 2).length,
        };

        // Atividade recente
        const recentes = subs.slice(0, 12).map(s => ({
          nome: s.nome, matricula: s.matricula, missionTitle: s.missionTitle,
          status: s.status, points: s.points, createdAt: s.createdAt,
        }));

        return res.status(200).json({
          resumo: {
            colaboradores: total,
            pontosTotais,
            missoesConcluidas: aprovados.length,
            comprovantesPendentes: pendentes.length,
            comprovantesAprovados: aprovados.filter(s => s.type === 'proof').length,
            comprovantesRecusados: recusados.length,
            documentos: subs.filter(s => s.fileId).length,
          },
          porNivel, trilhas, conquistas, engajamento, recentes,
        });
      }

      /* ---------- Ranking ---------- */
      if (action === 'overview') {
        const users = await listUsers();
        const subs = await listSubmissions({ limit: 500 });
        const pendentes = subs.filter(s => s.status === 'pendente').length;

        const ranking = users.map(u => ({
          matricula: u.matricula,
          nome: u.nome,
          points: u.points || 0,
          level: levelFor(u.points || 0),
          missoes: Object.values(u.done || {}).reduce((a, b) => a + b, 0),
          streak: u.streak || 0,
          rhValidado: !!u.rhValidado,
          createdAt: u.createdAt,
          lastCheckin: u.lastCheckin || null,
        })).sort((a, b) => b.points - a.points);

        return res.status(200).json({
          ranking,
          resumo: { colaboradores: ranking.length, comprovantesPendentes: pendentes },
        });
      }

      /* ---------- Ficha do colaborador: missões cumpridas ---------- */
      if (action === 'user') {
        const u = await getUser(req.query.m);
        if (!u) return res.status(404).json({ error: 'Colaborador não encontrado.' });

        const subs = await listSubmissions({ matricula: u.matricula, limit: 200 });
        const done = u.done || {};

        // Todas as missões do catálogo, marcando o que foi cumprido
        const trilhas = TRACKS.map(t => ({
          id: t.id,
          name: t.name,
          missions: t.missions.map(m => {
            const envios = subs.filter(s => s.missionId === m.id);
            return {
              id: m.id,
              title: m.title,
              points: m.points,
              type: m.type,
              repeatable: !!m.repeatable,
              vezes: done[m.id] || 0,
              concluida: (done[m.id] || 0) > 0,
              pendente: envios.some(s => s.status === 'pendente'),
              envios: envios.map(s => ({
                id: s.id, status: s.status, points: s.points,
                createdAt: s.createdAt, data: s.data || {},
                fileId: s.fileId || null, note: s.note || '',
              })),
            };
          }),
        }));

        const feitas = trilhas.flatMap(t => t.missions).filter(m => m.concluida).length;
        const totalMissoes = TRACKS.reduce((a, t) => a + t.missions.length, 0);

        return res.status(200).json({
          user: {
            matricula: u.matricula, nome: u.nome,
            points: u.points || 0, level: levelFor(u.points || 0),
            streak: u.streak || 0, lastCheckin: u.lastCheckin || null,
            createdAt: u.createdAt, rhValidado: !!u.rhValidado,
            missoesFeitas: feitas, totalMissoes,
          },
          trilhas,
        });
      }

      if (action === 'conversation') {
        const conv = await getConversation(req.query.m);
        if (!conv) return res.status(404).json({ error: 'Sem conversa registrada.' });
        return res.status(200).json({ conversation: conv });
      }

      if (action === 'submissions') {
        return res.status(200).json({ submissions: await listSubmissions({ limit: 400 }) });
      }

      /* ---------- Pasta de documentos ---------- */
      if (action === 'files') {
        const subs = await listSubmissions({ limit: 500 });
        const files = subs
          .filter(s => s.fileId)
          .map(s => ({
            subId: s.id,
            fileId: s.fileId,
            matricula: s.matricula,
            nome: s.nome,
            missionId: s.missionId,
            missionTitle: s.missionTitle,
            status: s.status,
            createdAt: s.createdAt,
            mime: mimeOf(s),
            fileName: s.fileName || 'comprovante',
          }));
        return res.status(200).json({ files });
      }

      if (action === 'file') {
        const data = await getFile(req.query.id);
        if (!data) return res.status(404).json({ error: 'Documento não encontrado.' });
        return res.status(200).json({ file: data });
      }

      if (action === 'prizes') {
        return res.status(200).json({ prizes: await getPrizes() });
      }

      /* ---------- Missões especiais criadas pelo gestor ---------- */
      if (action === 'custom') {
        const [missions, users, subs] = await Promise.all([
          listCustomMissions(),
          listUsers(),
          listSubmissions({ limit: 500 }),
        ]);
        const enriched = missions.map(m => {
          const alvos = (m.assignees || []);
          const feitos = subs.filter(s => s.missionId === m.id && s.status === 'aprovado');
          return {
            ...m,
            totalAlvos: alvos.length,
            concluidos: [...new Set(feitos.map(s => s.matricula))].length,
          };
        });
        return res.status(200).json({
          missions: enriched,
          colaboradores: users.map(u => ({ matricula: u.matricula, nome: u.nome })),
        });
      }

      return res.status(400).json({ error: 'Ação inválida.' });
    }

    /* ========================== ESCRITA ========================== */
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

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
          const pontos = sub.missionPoints ?? (found ? found.mission.points : 0);
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

      /* ---------- Criar / editar missão especial ---------- */
      if (action === 'custom') {
        const titulo = String(body.title || '').trim();
        const assignees = Array.isArray(body.assignees) ? body.assignees.map(String) : [];
        if (!titulo) return res.status(400).json({ error: 'Dê um título à missão.' });
        if (!assignees.length) return res.status(400).json({ error: 'Escolha pelo menos um colaborador.' });

        const pontos = Math.max(0, Math.min(1000, parseInt(body.points, 10) || 0));
        const tipo = body.type === 'proof' ? 'proof' : 'form';

        const mission = {
          id: body.id || ('cm_' + crypto.randomUUID().slice(0, 8)),
          title: titulo,
          desc: String(body.desc || '').slice(0, 400),
          points: pontos,
          type: tipo,
          repeatable: !!body.repeatable,
          assignees,
          ativo: body.ativo !== false,
          createdAt: body.createdAt || Date.now(),
        };

        if (tipo === 'proof') {
          mission.proofHint = String(body.proofHint || 'Envie um comprovante do que foi combinado.').slice(0, 300);
        } else {
          // Missão de formulário: um campo aberto para o colaborador relatar.
          mission.fields = [{
            id: 'relato',
            label: String(body.fieldLabel || 'Conte como você cumpriu esta missão').slice(0, 160),
            type: 'textarea',
          }];
        }

        await saveCustomMission(mission);
        return res.status(200).json({ ok: true, mission });
      }

      if (action === 'customDelete') {
        if (!body.id) return res.status(400).json({ error: 'Missão não informada.' });
        await deleteCustomMission(String(body.id));
        return res.status(200).json({ ok: true });
      }

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
