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
function activeObjectives(subs) {
  return subs
    .filter(x => x.missionId === 'obj_criar' && x.status === 'aprovado' && x.data)
    .map(x => ({ objetivo: x.data.objetivo || '', porMes: num(x.data.por_mes), custo: num(x.data.custo) }));
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
      if (mission.id === 'obj_criar') {
        // Só pontua se o objetivo for factível, couber no orçamento e não se sobrepor.
        const math = computeObjectiveMath(data);
        const subsAll = await listSubmissions({ matricula: user.matricula, limit: 200 });
        const budget = deriveBudget(subsAll);
        const future = deriveFutureBudget(subsAll);
        const income = deriveIncome(subsAll);
        const existentes = activeObjectives(subsAll);

        // Limite de 3 objetivos ativos.
        if (existentes.length >= 3) {
          return res.status(200).json({
            ok: false,
            message: 'Você já tem 3 objetivos, que é o limite. Conclua um ("Alcancei meu objetivo") ou ajuste antes de criar outro.',
          });
        }

        // Soma mensal de todos os objetivos (aprovados + este) x orçamento disponível.
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

        // Preenchimento sem sentido: rejeita (não conta como tentativa).
        if (!ai.valid) {
          return res.status(200).json({ ok: false, message: ai.feedback || 'Complete os campos do objetivo com valores reais.' });
        }

        // As três validações:
        const factivel = math.viavel;                       // (1) plausível/factível: fecha no prazo
        const dentroOrcamento = !extrapola;                 // (2) cabe no orçamento mensal
        const overlap = ai.overlap || codeOverlap(data.objetivo, existentes); // (3) não se sobrepõe
        const podePontuar = factivel && dentroOrcamento && !overlap;

        // Situação (para a cor e o texto da tela)
        let status;
        if (overlap) status = 'sobreposto';
        else if (extrapola) status = 'orcamento';
        else if (!factivel) status = 'ajustar';
        else if (budget && budget.sobra > 0 && math.porMes > 0.7 * budget.sobra) status = 'apertado';
        else status = 'viavel';

        const pctRenda = (income > 0) ? Math.round((math.porMes / income) * 100) : null;

        // Classificação do planejamento (IA), com fallback deterministico.
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
          pctRenda, somaExistente: Math.round(somaExistente), totalMensal,
          orcamentoDisponivel, baseTipo,
          sobraAtual: budget ? budget.sobra : null,
          sobraFutura: future ? future.sobraFutura : null,
        };
        const avaliacao = { status, classificacao, feedback: ai.feedback, objetivo: data.objetivo || '', pontuou: podePontuar, resumo };

        // Não pontua: NÃO salva o objetivo, devolve o feedback para a pessoa ajustar.
        if (!podePontuar) {
          return res.status(200).json({
            ok: true, pontuou: false, earned: 0,
            objetivo: avaliacao,
            user: publicUser(user),
          });
        }

        // Pontua: segue o fluxo normal de creditação.
        sub.status = 'aprovado';
        sub.points = mission.points;
        sub.note = status === 'apertado'
          ? 'Objetivo viável, mas aperta o orçamento.'
          : 'Objetivo viável e dentro do orçamento.';
        objetivoAvaliacao = avaliacao;
      } else if (mission.id === 'orc_metas') {
        // Valida se a proposta orçamentária é coerente.
        const brl = n => 'R$ ' + Number(n || 0).toLocaleString('pt-BR');
        const rendaF = num(data.renda_futura);
        const gastosF = num(data.gastos_futuros);
        if (rendaF <= 0) {
          return res.status(200).json({ ok: false, message: 'Informe uma renda meta maior que zero.' });
        }
        if (gastosF < 0) {
          return res.status(200).json({ ok: false, message: 'Os gastos meta não podem ser negativos.' });
        }
        if (gastosF > rendaF) {
          return res.status(200).json({
            ok: false,
            message: `Sua proposta não fecha: os gastos meta (${brl(gastosF)}) passam da renda meta (${brl(rendaF)}). Ajuste para sobrar algo e conseguir poupar.`,
          });
        }
        // Nonsense (ex.: "111", "aaa") ainda é barrado pela checagem de coerência da IA.
        const check = await validateForm(mission, data);
        if (!check.valid) {
          return res.status(200).json({ ok: false, message: check.feedback || 'Complete os campos com valores reais.' });
        }
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
      user: publicUser(user),
    });
  } catch (err) {
    console.error('missions:', err);
    return res.status(500).json({ error: 'Erro ao enviar a missão.' });
  }
}
