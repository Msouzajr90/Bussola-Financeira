// ============================================================================
//  Área educacional (aulas em vídeo do YouTube).
//    GET  /api/lessons          → lista de aulas + progresso do colaborador
//    POST /api/lessons          → concluir uma aula (assistiu + acertou o quiz)
//
//  Pontuação: o colaborador precisa assistir ~90% do vídeo (verificado no player)
//  E acertar o quiz. As respostas do quiz ficam só no servidor.
// ============================================================================
import {
  sessionUser, saveUser, listLessons, getLesson,
  saveSubmission, dbReady,
} from '../lib/store.js';
import { levelFor, publicUser } from '../lib/missions.js';
import { youtubeId } from '../lib/youtube.js';


// Versão pública das aulas: sem as respostas do quiz.
function publicLesson(l) {
  return {
    id: l.id,
    titulo: l.titulo,
    descricao: l.descricao,
    videoId: l.videoId,
    trilha: l.trilha || '',
    pontos: l.pontos,
    ordem: l.ordem || 0,
    quiz: (l.quiz || []).map(q => ({ q: q.q, options: q.options })),
  };
}

export default async function handler(req, res) {
  if (!dbReady) return res.status(500).json({ error: 'Banco de dados não configurado.' });

  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });

  /* ---------------- Lista de aulas + progresso ---------------- */
  if (req.method === 'GET') {
    const lessons = await listLessons();
    const feitas = user.lessonsDone || {};
    return res.status(200).json({
      lessons: lessons.filter(l => l.ativo !== false).map(l => ({
        ...publicLesson(l),
        concluida: !!feitas[l.id],
      })),
    });
  }

  /* ---------------- Concluir aula ---------------- */
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const lesson = await getLesson(body.lessonId);
      if (!lesson) return res.status(404).json({ error: 'Aula não encontrada.' });

      const feitas = user.lessonsDone || {};
      if (feitas[lesson.id]) return res.status(409).json({ error: 'Você já concluiu esta aula.' });

      // 1) Precisa ter assistido (o player informa o percentual assistido)
      const watched = Number(body.watched || 0);
      if (watched < 0.9) {
        return res.status(200).json({ ok: false, message: 'Assista à aula até o fim para liberar o quiz.' });
      }

      // 2) Precisa acertar todas as perguntas do quiz
      const quiz = lesson.quiz || [];
      if (quiz.length) {
        const answers = Array.isArray(body.answers) ? body.answers : [];
        const acertos = quiz.reduce((n, q, i) => n + (answers[i] === q.answer ? 1 : 0), 0);
        if (acertos < quiz.length) {
          return res.status(200).json({
            ok: false,
            quiz: { acertos, total: quiz.length },
            message: `Você acertou ${acertos} de ${quiz.length}. Revise o vídeo e tente de novo — sem perder pontos.`,
          });
        }
      }

      // Credita os pontos
      const pontos = lesson.pontos || 0;
      const antes = levelFor(user.points || 0).level;
      user.points = (user.points || 0) + pontos;
      user.lessonsDone = { ...feitas, [lesson.id]: Date.now() };
      const depois = levelFor(user.points).level;
      await saveUser(user);

      // Registra como um envio (aparece no painel do gestor e no CSV)
      await saveSubmission({
        id: 'lesson_' + lesson.id + '_' + user.matricula + '_' + Date.now(),
        matricula: user.matricula,
        nome: user.nome,
        missionId: 'aula:' + lesson.id,
        missionTitle: 'Aula: ' + lesson.titulo,
        type: 'aula',
        missionPoints: pontos,
        data: { assistido: Math.round(watched * 100) + '%' },
        points: pontos,
        status: 'aprovado',
        createdAt: Date.now(),
        note: '',
      });

      return res.status(200).json({
        ok: true,
        earned: pontos,
        levelUp: depois > antes ? levelFor(user.points) : null,
        user: publicUser(user),
      });
    } catch (err) {
      console.error('lessons:', err);
      return res.status(500).json({ error: 'Erro ao concluir a aula.' });
    }
  }

  return res.status(405).json({ error: 'Método não permitido.' });
}
