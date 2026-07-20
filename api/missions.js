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
  saveFile, getPrizes, customFor, countUsers, getSubmission, deleteSubmission, dbReady,
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
IMPORTANTE: valores ZERO (0) são respostas VÁLIDAS — muita gente realmente não tem gasto
em alguma categoria, ou ainda não guardou nada. NUNCA rejeite por causa de zeros, nem por
gastos maiores que a renda. Campos numéricos vazios também são aceitáveis (valem zero).
Rejeite somente se: valores claramente aleatórios ou de teste (ex.: 111111, "aaa", "teste"),
ou respostas de texto que não têm relação com a pergunta.

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

// Orçamento da pessoa (a partir da missão de orçamento): renda, gastos e sobra.
function deriveBudget(subs) {
  const s = subs.find(x => x.missionId === 'orc_montar' && x.data);
  if (!s) return null;
  const d = s.data;
  const renda = num(d.renda);
  const gastos = ['moradia', 'contas', 'alimentacao', 'transporte', 'parcelas', 'outros']
    .reduce((a, k) => a + num(d[k]), 0);
  return { renda, gastos: Math.round(gastos), sobra: Math.round(renda - gastos) };
}

// Metas de orçamento futuro (missão orc_metas): renda e gastos que a pessoa quer ter.
function deriveFutureBudget(subs) {
  const s = subs.find(x => x.missionId === 'orc_metas' && x.data);
  if (!s) return null;
  const d = s.data;
  const rendaFutura = num(d.renda_futura);
  const gastosFuturos = num(d.gastos_futuros);
  if (rendaFutura <= 0 && gastosFuturos <= 0) return null;
  return {
    rendaFutura: Math.round(rendaFutura),
    gastosFuturos: Math.round(gastosFuturos),
    sobraFutura: Math.round(rendaFutura - gastosFuturos),
    prazoMeta: Math.round(num(d.prazo_meta)),
  };
}

// Renda: do orçamento, ou do diagnóstico como fallback.
function deriveIncome(subs) {
  const b = deriveBudget(subs);
  if (b && b.renda > 0) return b.renda;
  const s = subs.find(x => x.missionId === 'diag_inicial' && x.data && x.data.renda);
  return s ? num(s.data.renda) : 0;
}

// Objetivos já aprovados (para somar o mensal e checar sobreposição).
function activeObjectives(subs, exceptId) {
  return subs
    .filter(x => x.missionId === 'obj_criar' && x.status === 'aprovado' && x.data)
    .filter(x => !exceptId || x.id !== exceptId)
    .map(x => ({ id: x.id, objetivo: x.data.objetivo || '', porMes: num(x.data.por_mes), custo: num(x.data.custo) }));
}

// Palavras-chave de um objetivo (sem acentos, sem verbos/artigos genéricos).
const STOP = new Set(['comprar', 'quero', 'ter', 'juntar', 'guardar', 'pagar', 'quitar',
  'um', 'uma', 'de', 'da', 'do', 'a', 'o', 'as', 'os', 'para', 'pra', 'por', 'com', 'em',
  'minha', 'meu', 'minhas', 'meus', 'propria', 'proprio', 'proprios', 'proprias',
  'novo', 'nova', 'novos', 'novas', 'meu', 'sonho', 'dos', 'das', 'no', 'na']);
function normalizeGoal(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
}
// Sobreposição por código (reforça a checagem semântica da IA).
function codeOverlap(newGoal, existentes) {
  const a = new Set(normalizeGoal(newGoal));
  if (!a.size) return false;
  for (const e of existentes) {
    const b = new Set(normalizeGoal(e.objetivo));
    if (!b.size) continue;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const uniao = new Set([...a, ...b]).size;
    if (uniao && inter / uniao >= 0.5) return true;
  }
  return false;
}

// Uma única chamada ao GPT: valida coerência, detecta sobreposição e escreve o feedback.
// Retorna { valid, overlap, feedback }. Em falha, não penaliza (valid=true, overlap=false).
async function evaluateObjective(ctx) {
  const { data, math, income, budget, future, existentes, totalMensal, orcamentoDisponivel, baseTipo, extrapola } = ctx;
  const apiKey = process.env.OPENAI_API_KEY;
  const brl = n => 'R$ ' + Number(n || 0).toLocaleString('pt-BR');

  if (!apiKey) return { valid: true, overlap: false, feedback: '' };

  const listaExist = existentes.length
    ? existentes.map(o => `- "${o.objetivo}" (guardando ${brl(o.porMes)}/mês)`).join('\n')
    : '(nenhum objetivo cadastrado ainda)';

  const contas = [
    `Novo objetivo: ${data.objetivo || '(não informado)'}`,
    `Custo: ${brl(math.custo)} | Já guardado: ${brl(math.jaTem)} | Prazo: ${math.prazoMeses} meses | Guardar por mês: ${brl(math.porMes)}`,
    ``,
    `CÁLCULOS JÁ FEITOS (use, não recalcule):`,
    math.viavel
      ? `- No ritmo informado, ALCANÇA o objetivo no prazo (sobra ${brl(-math.falta)}).`
      : `- No ritmo informado, NÃO alcança: faltariam ${brl(math.falta)}. Para fechar no prazo seria preciso ${brl(math.requeridoPorMes)}/mês.`,
    income > 0 ? `- Renda mensal: ${brl(income)}.` : `- Renda: não informada.`,
    budget ? `- Gastos mensais: ${brl(budget.gastos)} | Sobra por mês (orçamento atual): ${brl(budget.sobra)}.` : `- Orçamento atual: não informado.`,
    future ? `- META DE ORÇAMENTO FUTURO da pessoa: renda alvo ${brl(future.rendaFutura)}, gastos alvo ${brl(future.gastosFuturos)} → pretende SOBRAR ${brl(future.sobraFutura)}/mês${future.prazoMeta ? ` em ${future.prazoMeta} meses` : ''}.` : `- Meta de orçamento futuro: não informada.`,
    `- Somando este objetivo aos outros, o total a guardar por mês seria ${brl(totalMensal)}.`,
    orcamentoDisponivel != null
      ? `- Dinheiro disponível por mês para objetivos (base: ${baseTipo === 'meta_futura' ? 'META de orçamento futuro' : baseTipo === 'sobra' ? 'sobra do orçamento atual' : 'renda'}): ${brl(orcamentoDisponivel)}. ${extrapola ? 'ISSO EXTRAPOLA o disponível.' : 'Cabe no disponível.'}`
      : `- Não dá para checar o orçamento (faltam dados).`,
    ``,
    `Objetivos já cadastrados pela pessoa:`,
    listaExist,
  ].filter(Boolean).join('\n');

  const instrucao = `Você avalia um objetivo financeiro que um trabalhador brasileiro acabou de cadastrar.

Decida quatro coisas:
1. valid: true se o preenchimento é sério; false só se forem valores aleatórios/de teste (ex.: "111", "aaa").
2. overlap: true se este novo objetivo é essencialmente O MESMO que algum já cadastrado na lista (ex.: já tem "comprar casa" e cadastrou "casa própria"). Objetivos diferentes (casa e carro) NÃO são sobreposição.
3. classificacao: quão bem planejado está o objetivo, um de:
   - "bem": factível no prazo, cabe no orçamento/meta, valores realistas e coerentes.
   - "parcial": dá para seguir, mas com ressalvas (aperta o orçamento, prazo justo, ou algo a melhorar).
   - "insuficiente": não fecha no prazo, não cabe no orçamento, está mal preenchido/irrealista, ou é repetido.
4. feedback: um texto curto (máx. 90 palavras), em segunda pessoa ("você"), simples e caloroso, que:
   - Se está tudo certo (alcança o objetivo e cabe no orçamento): comemore e reforce o hábito.
   - Se NÃO alcança no prazo: explique com gentileza e sugira esticar o prazo, aumentar o valor mensal ou reduzir a meta (use números).
   - Se EXTRAPOLA o orçamento (a soma dos objetivos não cabe no disponível): avise com cuidado que o total mensal não cabe, e sugira priorizar um objetivo, reduzir valores ou alongar prazos. Se a base usada foi a META de orçamento futuro, deixe claro que a comparação já considera a meta dela (não só o orçamento de hoje).
   - Se é SOBREPOSIÇÃO: diga gentilmente que ele já tem esse objetivo e sugira ajustar o existente em vez de duplicar.
   - Nunca desanime a pessoa por sonhar. Não recomende produtos de investimento. Não peça dados sensíveis.

Responda SOMENTE com JSON, sem markdown: {"valid": true|false, "overlap": true|false, "classificacao": "insuficiente|parcial|bem", "feedback": "texto"}

Dados:
${contas}`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.5,
        messages: [{ role: 'user', content: instrucao }],
      }),
    });
    if (!r.ok) return { valid: true, overlap: false, feedback: '' };
    const j = await r.json();
    const txt = (j?.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(txt);
    return {
      valid: parsed.valid !== false,
      overlap: parsed.overlap === true,
      classificacao: parsed.classificacao,
      feedback: parsed.feedback || '',
    };
  } catch {
    return { valid: true, overlap: false, feedback: '' };
  }
}

// ----------------------------------------------------------------------------
//  Avalia um objetivo (criação OU edição). Faz as contas, consulta a IA e
//  decide se ele é factível, cabe no orçamento e não se sobrepõe.
//  exceptId: ao editar, ignora o próprio objetivo nas comparações.
// ----------------------------------------------------------------------------
async function assessObjective({ matricula, data, exceptId, checkLimit }) {
  const math = computeObjectiveMath(data);
  const subsAll = await listSubmissions({ matricula, limit: 200 });
  const budget = deriveBudget(subsAll);
  const future = deriveFutureBudget(subsAll);
  const income = deriveIncome(subsAll);
  const existentes = activeObjectives(subsAll, exceptId);

  if (checkLimit && existentes.length >= 3) {
    return {
      blocked: true,
      message: 'Você já tem 3 objetivos, que é o limite. Exclua ou conclua um antes de criar outro.',
    };
  }

  const somaExistente = existentes.reduce((a, o) => a + o.porMes, 0);
  const totalMensal = Math.round(somaExistente + math.porMes);

  // A comparação prioriza a META DE ORÇAMENTO FUTURO, quando informada.
  let orcamentoDisponivel = null, baseTipo = null;
  if (future && future.sobraFutura > 0) { orcamentoDisponivel = future.sobraFutura; baseTipo = 'meta_futura'; }
  else if (budget) { orcamentoDisponivel = budget.sobra; baseTipo = 'sobra'; }
  else if (income > 0) { orcamentoDisponivel = income; baseTipo = 'renda'; }
  const extrapola = orcamentoDisponivel != null && totalMensal > orcamentoDisponivel;

  const ai = await evaluateObjective({
    data, math, income, budget, future, existentes,
    totalMensal, orcamentoDisponivel, baseTipo, extrapola,
  });

  if (!ai.valid) {
    return { blocked: true, message: ai.feedback || 'Complete os campos do objetivo com valores reais.' };
  }

  const factivel = math.viavel;
  const dentroOrcamento = !extrapola;
  const overlap = ai.overlap || codeOverlap(data.objetivo, existentes);
  const podePontuar = factivel && dentroOrcamento && !overlap;

  let status;
  if (overlap) status = 'sobreposto';
  else if (extrapola) status = 'orcamento';
  else if (!factivel) status = 'ajustar';
  else if (budget && budget.sobra > 0 && math.porMes > 0.7 * budget.sobra) status = 'apertado';
  else status = 'viavel';

  let classificacao = ai.classificacao;
  if (!['insuficiente', 'parcial', 'bem'].includes(classificacao)) {
    if (!podePontuar) classificacao = 'insuficiente';
    else if (status === 'apertado') classificacao = 'parcial';
    else classificacao = 'bem';
  }

  const resumo = {
    custo: math.custo, jaTem: math.jaTem, prazoMeses: math.prazoMeses,
    porMes: math.porMes, viavel: math.viavel, falta: math.falta,
    requeridoPorMes: math.requeridoPorMes, mesesNoRitmo: math.mesesNoRitmo,
    pctRenda: income > 0 ? Math.round((math.porMes / income) * 100) : null,
    somaExistente: Math.round(somaExistente), totalMensal,
    orcamentoDisponivel, baseTipo,
    sobraAtual: budget ? budget.sobra : null,
    sobraFutura: future ? future.sobraFutura : null,
  };

  return {
    blocked: false,
    avaliacao: {
      status, classificacao, feedback: ai.feedback,
      objetivo: data.objetivo || '', pontuou: podePontuar, resumo,
    },
  };
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

    /* ---------------- Excluir um objetivo ---------------- */
    // Os pontos daquele objetivo são devolvidos, para não virar farm de pontos
    // (criar e excluir repetidamente).
    if (body.action === 'objExcluir') {
      const alvo = await getSubmission(String(body.id || ''));
      if (!alvo || alvo.matricula !== user.matricula || alvo.missionId !== 'obj_criar') {
        return res.status(404).json({ error: 'Objetivo não encontrado.' });
      }
      const devolver = alvo.points || 0;
      user.points = Math.max(0, (user.points || 0) - devolver);
      const d = { ...(user.done || {}) };
      d.obj_criar = Math.max(0, (d.obj_criar || 1) - 1);
      user.done = d;
      await saveUser(user);
      await deleteSubmission(alvo);
      return res.status(200).json({ ok: true, removidos: devolver, user: publicUser(user) });
    }

    /* ---------------- Editar um objetivo ---------------- */
    // Passa pelas mesmas validações, mas NÃO concede pontos de novo.
    if (body.action === 'objEditar') {
      const alvo = await getSubmission(String(body.id || ''));
      if (!alvo || alvo.matricula !== user.matricula || alvo.missionId !== 'obj_criar') {
        return res.status(404).json({ error: 'Objetivo não encontrado.' });
      }
      const novo = body.data || {};
      const av = await assessObjective({ matricula: user.matricula, data: novo, exceptId: alvo.id });
      if (av.blocked) return res.status(200).json({ ok: false, message: av.message });
      if (!av.avaliacao.pontuou) {
        return res.status(200).json({ ok: true, pontuou: false, editado: false, objetivo: av.avaliacao });
      }
      alvo.data = novo;
      alvo.note = av.avaliacao.status === 'apertado'
        ? 'Objetivo viável, mas aperta o orçamento. (editado)'
        : 'Objetivo viável e dentro do orçamento. (editado)';
      alvo.editadoEm = Date.now();
      await saveSubmission(alvo);
      return res.status(200).json({ ok: true, pontuou: true, editado: true, objetivo: av.avaliacao, user: publicUser(user) });
    }

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
    let objetivoAvaliacao = null, orcamentoResumo = null;
    if (mission.type === 'form') {
      if (mission.id === 'obj_criar') {
        const av = await assessObjective({ matricula: user.matricula, data, checkLimit: true });
        if (av.blocked) return res.status(200).json({ ok: false, message: av.message });

        // Não pontua: NÃO salva o objetivo, devolve o feedback para a pessoa ajustar.
        if (!av.avaliacao.pontuou) {
          return res.status(200).json({
            ok: true, pontuou: false, earned: 0,
            objetivo: av.avaliacao,
            user: publicUser(user),
          });
        }

        // Pontua: segue o fluxo normal de creditação.
        sub.status = 'aprovado';
        sub.points = mission.points;
        sub.note = av.avaliacao.status === 'apertado'
          ? 'Objetivo viável, mas aperta o orçamento.'
          : 'Objetivo viável e dentro do orçamento.';
        objetivoAvaliacao = av.avaliacao;
      } else if (mission.id === 'orc_montar') {
        // O orçamento SEMPRE é aceito, mesmo no vermelho. O estouro vira destaque.
        const check = await validateForm(mission, data);
        if (!check.valid) {
          return res.status(200).json({ ok: false, message: check.feedback || 'Confira o preenchimento.' });
        }
        const b = deriveBudget([{ missionId: 'orc_montar', data }]);
        const cats = ['moradia', 'contas', 'alimentacao', 'transporte', 'parcelas', 'outros'];
        const zerados = ['renda', ...cats].filter(k => num(data[k]) === 0);
        orcamentoResumo = {
          renda: b.renda, gastos: b.gastos, saldo: b.sobra,
          estouro: b.sobra < 0, excesso: Math.abs(Math.min(0, b.sobra)),
          zerados,
        };
        sub.status = 'aprovado';
        sub.points = mission.points;
        sub.note = b.sobra < 0
          ? `Orçamento estourado em R$ ${Math.abs(b.sobra)}.`
          : `Sobra de R$ ${b.sobra}/mês.`;
      } else if (mission.id === 'orc_metas') {
        // Valida se a proposta orçamentária é coerente.
        const brl = n => 'R$ ' + Number(n || 0).toLocaleString('pt-BR');
        const rendaF = num(data.renda_futura);
        const gastosF = num(data.gastos_futuros);
        if (gastosF < 0 || rendaF < 0) {
          return res.status(200).json({ ok: false, message: 'Os valores não podem ser negativos.' });
        }
        if (gastosF > rendaF) {
          return res.status(200).json({
            ok: false,
            message: `Sua proposta não fecha: os gastos meta (${brl(gastosF)}) passam da renda meta (${brl(rendaF)}). Como isto é uma meta, ajuste para sobrar algo e conseguir poupar.`,
          });
        }
        // Nonsense (ex.: "aaa") ainda é barrado pela checagem de coerência da IA.
        const check = await validateForm(mission, data);
        if (!check.valid) {
          return res.status(200).json({ ok: false, message: check.feedback || 'Complete os campos com valores reais.' });
        }
        const zerados = ['renda_futura', 'gastos_futuros', 'prazo_meta'].filter(k => num(data[k]) === 0);
        orcamentoResumo = {
          meta: true, renda: rendaF, gastos: gastosF, saldo: rendaF - gastosF,
          estouro: false, excesso: 0, zerados,
        };
        sub.status = 'aprovado';
        sub.points = mission.points;
        sub.note = `Meta: sobrar ${brl(rendaF - gastosF)}/mês`;
      } else {
        const check = await validateForm(mission, data);
        if (!check.valid) {
          return res.status(200).json({ ok: false, message: check.feedback || 'Faltou completar alguns campos.' });
        }
        sub.status = 'aprovado';
        sub.points = mission.points;
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
      orcamento: orcamentoResumo,
      user: publicUser(user),
    });
  } catch (err) {
    console.error('missions:', err);
    return res.status(500).json({ error: 'Erro ao enviar a missão.' });
  }
}
