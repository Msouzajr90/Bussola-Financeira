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
  saveFile, getPrizes, customFor, countUsers, dbReady,
} from '../lib/store.js';
import { publicCatalog, findMission, levelFor, STREAK_BONUS, publicUser } from '../lib/missions.js';

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

// ============================================================================
//  Avaliação de OBJETIVOS (missão "Crie um objetivo com prazo").
//  A CONTA é feita aqui, no código (LLM não faz aritmética confiável).
//  O GPT recebe os números prontos e só escreve o feedback humano.
// ============================================================================
function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}

function computeObjectiveMath(data) {
  const custo = num(data.custo);
  const jaTem = num(data.ja_tem);
  const prazoMeses = Math.round(num(data.prazo_meses));
  const porMes = num(data.por_mes);

  const totalPoupado = jaTem + porMes * Math.max(prazoMeses, 0);
  const falta = Math.round(custo - totalPoupado);
  const viavel = falta <= 0;
  const restante = Math.max(0, custo - jaTem);
  const requeridoPorMes = prazoMeses > 0 ? Math.max(0, Math.round(restante / prazoMeses)) : null;
  const mesesNoRitmo = porMes > 0 ? Math.ceil(restante / porMes) : null;

  return {
    custo, jaTem, prazoMeses, porMes,
    totalPoupado: Math.round(totalPoupado),
    falta, viavel, requeridoPorMes, mesesNoRitmo,
  };
}

function objectiveStatus(math, income) {
  const mensal = math.viavel ? math.porMes : math.requeridoPorMes;
  const pctRenda = (income > 0 && mensal) ? Math.round((mensal / income) * 100) : null;
  let status;
  if (!math.viavel) status = 'ajustar';
  else if (pctRenda != null && pctRenda > 40) status = 'apertado';
  else status = 'viavel';
  return { status, pctRenda };
}

// Busca a renda que a pessoa já informou (orçamento ou diagnóstico).
async function personIncome(matricula) {
  try {
    const subs = await listSubmissions({ matricula, limit: 150 });
    const fontes = ['orc_montar', 'diag_inicial'];
    for (const id of fontes) {
      const s = subs.find(x => x.missionId === id && x.data && x.data.renda);
      if (s) { const r = num(s.data.renda); if (r > 0) return r; }
    }
  } catch { /* ignora */ }
  return 0;
}

async function objectiveFeedback(data, math, income, pctRenda) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return '';

  const brl = n => 'R$ ' + Number(n || 0).toLocaleString('pt-BR');
  const contas = [
    `Objetivo: ${data.objetivo || '(não informado)'}`,
    `Custo estimado: ${brl(math.custo)}`,
    `Já guardado: ${brl(math.jaTem)}`,
    `Prazo desejado: ${math.prazoMeses} meses`,
    `Pretende guardar por mês: ${brl(math.porMes)}`,
    ``,
    `CÁLCULOS JÁ FEITOS (use estes números, não recalcule):`,
    `- No ritmo informado, junta ${brl(math.totalPoupado)} ao fim do prazo.`,
    math.viavel
      ? `- Isso ALCANÇA o objetivo (sobra ${brl(-math.falta)}).`
      : `- Isso NÃO alcança: faltariam ${brl(math.falta)}.`,
    math.requeridoPorMes != null
      ? `- Para fechar exatamente no prazo, precisaria guardar ${brl(math.requeridoPorMes)} por mês.`
      : `- Prazo não informado corretamente.`,
    math.mesesNoRitmo != null
      ? `- No ritmo atual, alcançaria em cerca de ${math.mesesNoRitmo} meses.`
      : ``,
    income > 0 ? `- Renda mensal informada pela pessoa: ${brl(income)}.` : `- Renda da pessoa: não informada.`,
    (income > 0 && pctRenda != null) ? `- O valor mensal representa cerca de ${pctRenda}% da renda dela.` : ``,
  ].filter(Boolean).join('\n');

  const instrucao = `Você é um orientador de finanças pessoais acolhedor, falando com um trabalhador brasileiro sobre um objetivo que ele acabou de cadastrar.

Escreva um feedback curto (3 a 5 frases), em segunda pessoa ("você"), linguagem simples e calorosa.

Regras:
- Seja honesto sobre a viabilidade, mas NUNCA desanime a pessoa por sonhar. Objetivo ambicioso é bom.
- Se o plano fecha, comemore e reforce o hábito. Se não fecha, aponte isso com gentileza e ofereça 2 caminhos concretos: esticar o prazo, aumentar o valor mensal ou ajustar a meta (diga números quando ajudar).
- Se o valor mensal for uma fatia grande da renda, comente com cuidado que precisa caber no orçamento.
- Não recomende produtos de investimento específicos. Não peça dados sensíveis (senha, cartão, CPF).
- Incorpore os números na conversa de forma natural; não devolva uma lista de números crus.
- No máximo 90 palavras.

Dados do objetivo e cálculos:
${contas}`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.6,
        messages: [{ role: 'user', content: instrucao }],
      }),
    });
    if (!r.ok) return '';
    const j = await r.json();
    return (j?.choices?.[0]?.message?.content || '').trim();
  } catch {
    return '';
  }
}

export default async function handler(req, res) {
  if (!dbReady) return res.status(500).json({ error: 'Banco de dados não configurado.' });

  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });

  /* ---------------- Estado ---------------- */
  if (req.method === 'GET') {
    const [subs, prizes, custom, comunidade] = await Promise.all([
      listSubmissions({ matricula: user.matricula, limit: 150 }),
      getPrizes(),
      customFor(user.matricula),
      countUsers(),
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
      comunidade,
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
    let objetivoAvaliacao = null;
    if (mission.type === 'form') {
      const check = await validateForm(mission, data);
      if (!check.valid) {
        return res.status(200).json({ ok: false, message: check.feedback || 'Faltou completar alguns campos.' });
      }
      sub.status = 'aprovado';
      sub.points = mission.points;

      // Objetivos ganham uma avaliação de viabilidade + feedback da IA.
      if (mission.id === 'obj_criar') {
        const math = computeObjectiveMath(data);
        const income = await personIncome(user.matricula);
        const { status, pctRenda } = objectiveStatus(math, income);
        const feedback = await objectiveFeedback(data, math, income, pctRenda);
        objetivoAvaliacao = {
          status,
          feedback,
          objetivo: data.objetivo || '',
          resumo: {
            custo: math.custo, jaTem: math.jaTem, prazoMeses: math.prazoMeses,
            porMes: math.porMes, viavel: math.viavel, falta: math.falta,
            requeridoPorMes: math.requeridoPorMes, mesesNoRitmo: math.mesesNoRitmo,
            pctRenda,
          },
        };
        // Guarda um resumo no envio, para o gestor ver depois.
        sub.note = math.viavel
          ? 'Objetivo viável no ritmo informado.'
          : `Objetivo precisa de ajuste: faltariam R$ ${math.falta} no prazo.`;
      }
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
      objetivo: objetivoAvaliacao,
      user: publicUser(user),
    });
  } catch (err) {
    console.error('missions:', err);
    return res.status(500).json({ error: 'Erro ao enviar a missão.' });
  }
}
