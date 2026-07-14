// ============================================================================
//  Missões — estado do colaborador e envio de missões.
//    GET  /api/missions        → catálogo + progresso + prêmios
//    POST /api/missions        → envia uma missão
//
//  A escada de comprovação (ver lib/missions.js):
//    form   → o GPT confere a coerência antes de liberar os pontos
//    quiz   → correção automática
//    checkin→ autodeclaração semanal, com bônus de sequência
//    proof  → vai para aprovação do gestor; só pontua quando aprovado
// ============================================================================
import crypto from 'node:crypto';
import {
  sessionUser, saveUser, saveSubmission, listSubmissions,
  saveFile, getPrizes, customFor, dbReady,
} from '../lib/store.js';
import { publicCatalog, findMission, levelFor, STREAK_BONUS } from '../lib/missions.js';
import { publicUser } from './auth.js';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Pede ao GPT que confira se o formulário foi preenchido de forma coerente.
// Isso impede que a pessoa ganhe pontos digitando "111, 111, 111".
async function validateForm(mission, data) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { valid: true, feedback: '' }; // sem chave, não bloqueia

  const campos = (mission.fields || [])
    .map(f => `- ${f.label}: ${data[f.id] ?? '(vazio)'}`)
    .join('\n');

  const instrucoes = `Você confere o preenchimento de uma missão de educação financeira.
Missão: "${mission.title}" — ${mission.desc}

Respostas do colaborador:
${campos}

Avalie APENAS se o preenchimento é sério e coerente — não julgue a situação financeira
da pessoa, nem se ela está endividada ou ganha pouco. Estar no vermelho é aceitável.
Rejeite somente se: houver campos essenciais vazios, valores claramente aleatórios ou
de teste (ex.: 111, 999, "aaa"), ou respostas que não têm relação com a pergunta.

Responda SOMENTE com JSON, sem markdown:
{"valid": true|false, "feedback": "uma frase curta, gentil, dizendo o que falta"}`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        messages: [{ role: 'user', content: instrucoes }],
      }),
    });
    if (!r.ok) return { valid: true, feedback: '' };
    const j = await r.json();
    const txt = (j?.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(txt);
    return { valid: parsed.valid !== false, feedback: parsed.feedback || '' };
  } catch {
    return { valid: true, feedback: '' }; // em caso de falha, não penaliza o colaborador
  }
}

export default async function handler(req, res) {
  if (!dbReady) return res.status(500).json({ error: 'Banco de dados não configurado.' });

  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });

  /* ---------------- Estado ---------------- */
  if (req.method === 'GET') {
    const [subs, prizes, custom] = await Promise.all([
      listSubmissions({ matricula: user.matricula, limit: 150 }),
      getPrizes(),
      customFor(user.matricula),
    ]);

    const tracks = publicCatalog();

    // Missões criadas pelo gestor especialmente para este colaborador
    if (custom.length) {
      tracks.push({
        id: 'especiais',
        name: 'Missões especiais',
        intro: 'Missões definidas pelo gestor do programa para você.',
        missions: custom.map(m => ({
          id: m.id, title: m.title, desc: m.desc, points: m.points,
          type: m.type, repeatable: !!m.repeatable,
          fields: m.fields, proofHint: m.proofHint, custom: true,
        })),
      });
    }

    return res.status(200).json({
      user: publicUser(user),
      tracks,
      prizes,
      submissions: subs.map(s => ({
        id: s.id, missionId: s.missionId, missionTitle: s.missionTitle,
        status: s.status, points: s.points, createdAt: s.createdAt,
        note: s.note || '', data: s.data || {}, hasFile: !!s.fileId,
      })),
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  /* ---------------- Envio ---------------- */
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // A missão pode vir do catálogo padrão ou ser uma missão especial do gestor.
    let mission = null;
    const found = findMission(body.missionId);
    if (found) {
      mission = found.mission;
    } else {
      const custom = await customFor(user.matricula);
      mission = custom.find(m => m.id === body.missionId) || null;
    }
    if (!mission) return res.status(400).json({ error: 'Missão não encontrada ou não atribuída a você.' });
    const isCustom = !found;
    const done = user.done || {};
    if (done[mission.id] && !mission.repeatable) {
      return res.status(409).json({ error: 'Você já concluiu esta missão.' });
    }

    const data = body.data || {};
    const sub = {
      id: crypto.randomUUID(),
      matricula: user.matricula,
      nome: user.nome,
      missionId: mission.id,
      missionTitle: mission.title,
      type: mission.type,
      missionPoints: mission.points,
      custom: isCustom,
      data,
      points: 0,
      status: 'pendente',
      createdAt: Date.now(),
      note: '',
    };

    /* --- QUIZ: correção automática --- */
    if (mission.type === 'quiz') {
      const answers = Array.isArray(data.answers) ? data.answers : [];
      const total = mission.questions.length;
      const acertos = mission.questions.reduce((n, q, i) => n + (answers[i] === q.answer ? 1 : 0), 0);
      if (acertos < total) {
        return res.status(200).json({
          ok: false,
          quiz: { acertos, total },
          message: `Você acertou ${acertos} de ${total}. Revise a lição e tente de novo — sem pressa, e sem perder pontos.`,
        });
      }
      sub.status = 'aprovado';
      sub.points = mission.points;
    }

    /* --- FORM: o GPT confere a coerência --- */
    if (mission.type === 'form') {
      const check = await validateForm(mission, data);
      if (!check.valid) {
        return res.status(200).json({ ok: false, message: check.feedback || 'Faltou completar alguns campos.' });
      }
      sub.status = 'aprovado';
      sub.points = mission.points;
    }

    /* --- CHECK-IN: uma vez por semana, com bônus de sequência --- */
    let bonus = 0;
    if (mission.type === 'checkin') {
      const last = user.lastCheckin || 0;
      const dias = (Date.now() - last) / 86400000;
      if (last && dias < 6) {
        return res.status(200).json({ ok: false, message: 'Seu próximo check-in libera daqui a alguns dias. Volte na semana que vem!' });
      }
      user.streak = (dias <= 10 || !last) ? (user.streak || 0) + 1 : 1;
      user.lastCheckin = Date.now();
      sub.status = 'aprovado';
      sub.points = mission.points;
      if (user.streak > 0 && user.streak % STREAK_BONUS.every === 0) {
        bonus = STREAK_BONUS.points;
        sub.note = `Bônus de sequência: +${bonus} pts (${user.streak} check-ins seguidos)`;
      }
    }

    /* --- PROOF: comprovante → aprovação do gestor --- */
    if (mission.type === 'proof') {
      if (!body.file || typeof body.file !== 'string' || !body.file.startsWith('data:')) {
        return res.status(400).json({ error: 'Envie uma foto ou PDF do comprovante.' });
      }
      if (body.file.length > 1_400_000) {
        return res.status(413).json({ error: 'Arquivo muito grande. Tente uma foto menor.' });
      }
      const fileId = crypto.randomUUID();
      await saveFile(fileId, body.file);
      sub.fileId = fileId;
      sub.fileName = String(body.fileName || 'comprovante');
      sub.fileMime = body.file.slice(5, body.file.indexOf(';')) || 'image/jpeg';
      sub.status = 'pendente';   // pontos só depois da aprovação
      sub.points = 0;
      await saveSubmission(sub);
      return res.status(200).json({
        ok: true,
        pending: true,
        message: 'Comprovante enviado! O gestor vai analisar e os pontos entram assim que for aprovado.',
        user: publicUser(user),
      });
    }

    /* --- Credita os pontos --- */
    const ganho = sub.points + bonus;
    user.points = (user.points || 0) + ganho;
    user.done = { ...done, [mission.id]: (done[mission.id] || 0) + 1 };

    const antes = levelFor(user.points - ganho).level;
    const depois = levelFor(user.points).level;

    await saveUser(user);
    await saveSubmission(sub);

    return res.status(200).json({
      ok: true,
      earned: ganho,
      bonus,
      levelUp: depois > antes ? levelFor(user.points) : null,
      user: publicUser(user),
    });
  } catch (err) {
    console.error('missions:', err);
    return res.status(500).json({ error: 'Erro ao enviar a missão.' });
  }
}
