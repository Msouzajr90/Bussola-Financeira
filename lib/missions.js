// ============================================================================
//  Catálogo do programa — trilhas, missões, pontuação e níveis.
//  Este é o "coração" da gamificação. Para ajustar o programa, edite aqui.
//
//  Tipos de missão (escada de comprovação):
//    form   → a pessoa preenche um formulário estruturado. O próprio GPT
//             valida se está coerente antes de liberar os pontos.
//    quiz   → perguntas de múltipla escolha, corrigidas automaticamente.
//    proof  → exige envio de comprovante (foto/PDF) + aprovação do gestor.
//    checkin→ autodeclaração semanal (vale poucos pontos, é recorrente).
// ============================================================================

export const LEVELS = [
  { level: 1, name: 'Iniciante',   min: 0 },
  { level: 2, name: 'Organizado',  min: 300 },
  { level: 3, name: 'No controle', min: 800 },
  { level: 4, name: 'Construtor',  min: 1500 },
  { level: 5, name: 'Referência',  min: 2500 },
];

export function levelFor(points) {
  let cur = LEVELS[0];
  for (const l of LEVELS) if (points >= l.min) cur = l;
  const next = LEVELS.find(l => l.min > points) || null;
  return {
    level: cur.level,
    name: cur.name,
    points,
    nextLevel: next ? next.level : null,
    nextName: next ? next.name : null,
    nextAt: next ? next.min : null,
    toNext: next ? next.min - points : 0,
    progress: next ? Math.round(((points - cur.min) / (next.min - cur.min)) * 100) : 100,
  };
}

export const TRACKS = [
  {
    id: 'diagnostico',
    name: 'Diagnóstico',
    base: true,
    intro: 'Todo mapa começa com um "você está aqui". Bora achar o seu.',
    missions: [
      {
        id: 'perfil_cadastro',
        title: 'Complete seu cadastro',
        desc: 'Rapidinho: só o básico para o programa ser seu. A foto é opcional.',
        points: 40,
        type: 'perfil',
        fields: [
          { id: 'nascimento', label: 'Data de nascimento', type: 'date' },
          { id: 'casado', label: 'Você é casado(a) ou tem união estável?', type: 'select', options: ['Não', 'Sim'] },
          { id: 'filhos', label: 'Você tem filhos?', type: 'select', options: ['Não', 'Sim'] },
        ],
      },
      {
        id: 'diag_inicial',
        title: 'Faça seu check-in inicial',
        desc: 'Um retrato rápido da sua situação hoje. Não existe resposta errada.',
        points: 50,
        type: 'form',
        fields: [
          { id: 'renda', label: 'Renda mensal aproximada (R$)', type: 'number' },
          { id: 'sobra', label: 'No fim do mês costuma sobrar, empatar ou faltar?', type: 'select', options: ['Sobra', 'Empata', 'Falta'] },
          { id: 'tem_dividas', label: 'Você tem dívidas hoje?', type: 'select', options: ['Não', 'Sim'] },
          { id: 'usa_cartao', label: 'Costuma usar cartão de crédito?', type: 'select', options: ['Não', 'Sim'] },
          { id: 'tem_reserva', label: 'Você já tem uma reserva de emergência?', type: 'select', options: ['Não', 'Sim'] },
          { id: 'tem_objetivo', label: 'Tem algum sonho ou objetivo que quer realizar?', type: 'select', options: ['Não', 'Sim'] },
          { id: 'preocupacao', label: 'O que mais te preocupa hoje no dinheiro?', type: 'textarea' },
        ],
      },
      {
        id: 'diag_registrato',
        title: 'Conheça suas dívidas reais',
        desc: 'Baixe seu Registrato no site do Banco Central (é gratuito) e envie o resumo. Ele mostra todas as suas dívidas no sistema financeiro.',
        points: 120,
        type: 'proof',
        proofHint: 'Envie o print ou PDF do Registrato. Você pode ocultar números de conta antes de enviar.',
      },
    ],
  },
  {
    id: 'orcamento',
    name: 'Orçamento',
    base: true,
    intro: 'Dinheiro sem controle é que nem pão quente: some e você nem viu como.',
    missions: [
      {
        id: 'orc_montar',
        title: 'Monte seu orçamento do mês',
        desc: 'Preencha suas entradas e seus principais gastos. O Orientador vai conferir se está coerente.',
        points: 100,
        type: 'form',
        fields: [
          { id: 'renda', label: 'Total que entra no mês (R$)', type: 'number' },
          { id: 'moradia', label: 'Moradia — aluguel, prestação, condomínio (R$)', type: 'number' },
          { id: 'contas', label: 'Contas — água, luz, gás, internet (R$)', type: 'number' },
          { id: 'alimentacao', label: 'Alimentação (R$)', type: 'number' },
          { id: 'transporte', label: 'Transporte (R$)', type: 'number' },
          { id: 'parcelas', label: 'Parcelas e dívidas (R$)', type: 'number' },
          { id: 'outros', label: 'Outros gastos (R$)', type: 'number' },
        ],
      },
      {
        id: 'orc_revisar',
        title: 'Revise o orçamento no mês seguinte',
        desc: 'Compare o que você planejou com o que aconteceu de verdade.',
        points: 80,
        type: 'form',
        repeatable: true,
        fields: [
          { id: 'gastou_mais', label: 'Em qual categoria você gastou mais do que esperava?', type: 'text' },
          { id: 'motivo', label: 'O que aconteceu?', type: 'textarea' },
          { id: 'ajuste', label: 'O que você vai ajustar neste mês?', type: 'textarea' },
        ],
      },
      {
        id: 'orc_metas',
        title: 'Defina suas metas de orçamento',
        desc: 'Aonde você quer chegar: quanto quer que entre e quanto quer gastar por mês. É isso que vai guiar seus objetivos.',
        points: 80,
        type: 'form',
        fields: [
          { id: 'renda_futura', label: 'Renda mensal que você quer/espera ter — sua meta (R$)', type: 'number' },
          { id: 'gastos_futuros', label: 'Gastos mensais que você quer ter — sua meta (R$)', type: 'number' },
          { id: 'prazo_meta', label: 'Em quantos meses quer chegar nessa meta?', type: 'number' },
          { id: 'como', label: 'O que você vai mudar para chegar lá?', type: 'textarea' },
        ],
      },
    ],
  },
  {
    id: 'dividas',
    name: 'Dívidas',
    intro: 'Encarar a dívida de frente já tira metade do peso das costas.',
    missions: [
      {
        id: 'div_mapear',
        title: 'Mapeie suas dívidas',
        desc: 'Liste tudo o que você deve, uma a uma. Ver o tamanho real costuma assustar menos do que não saber.',
        points: 100,
        type: 'dividas',
      },
      {
        id: 'div_plano',
        title: 'Monte seu plano de quitação',
        desc: 'Converse com o Orientador e registre a ordem em que vai atacar as dívidas.',
        points: 150,
        type: 'form',
        fields: [
          { id: 'prioridade', label: 'Qual dívida você vai atacar primeiro e por quê?', type: 'textarea' },
          { id: 'valor_mes', label: 'Quanto vai destinar por mês a essa dívida? (R$)', type: 'number' },
          { id: 'prazo', label: 'Em quantos meses pretende quitá-la?', type: 'number' },
        ],
      },
      {
        id: 'div_quitada',
        title: 'Quitei uma dívida',
        desc: 'Comprove uma dívida quitada ou renegociada. Envie o comprovante ou o acordo.',
        points: 300,
        type: 'proof',
        repeatable: true,
        proofHint: 'Comprovante de quitação, acordo de renegociação ou carta de quitação. Oculte dados sensíveis se quiser.',
      },
    ],
  },
  {
    id: 'cartao',
    name: 'Cartão de crédito',
    intro: 'O limite do cartão não é salário — por mais que ele finja que é.',
    missions: [
      {
        id: 'cart_licao',
        title: 'Lição: fatura, mínimo e rotativo',
        desc: 'Uma micro-lição rápida, com 3 perguntas ao final.',
        points: 60,
        type: 'quiz',
        questions: [
          {
            q: 'Pagar apenas o valor mínimo da fatura significa que:',
            options: [
              'A dívida some e você começa o mês zerado',
              'O restante entra no rotativo, que costuma ter juros altos',
              'O banco perdoa os juros do mês',
            ],
            answer: 1,
          },
          {
            q: 'O limite do cartão é:',
            options: [
              'Um dinheiro seu, que já está na conta',
              'Um empréstimo que o banco oferece — não é sua renda',
              'Um bônus que a empresa paga',
            ],
            answer: 1,
          },
          {
            q: 'Muitas compras parceladas ao mesmo tempo:',
            options: [
              'Não afetam os próximos meses',
              'Comprometem as faturas futuras, mesmo parecendo pequenas',
              'Reduzem os juros do rotativo',
            ],
            answer: 1,
          },
        ],
      },
      {
        id: 'cart_plano',
        title: 'Registre seu plano para o cartão',
        desc: 'Como você vai usar o cartão daqui pra frente.',
        points: 100,
        type: 'form',
        fields: [
          { id: 'fatura', label: 'Valor da fatura atual (R$)', type: 'number' },
          { id: 'paga_total', label: 'Você consegue pagar a fatura inteira?', type: 'select', options: ['Sim', 'Não', 'Às vezes'] },
          { id: 'plano', label: 'Qual seu plano para o cartão nos próximos meses?', type: 'textarea' },
        ],
      },
    ],
  },
  {
    id: 'reserva',
    name: 'Reserva de emergência',
    intro: 'Reserva é o guarda-chuva que você monta antes da chuva chegar.',
    missions: [
      {
        id: 'res_meta',
        title: 'Defina sua meta de reserva',
        desc: 'A regra de ouro: guardar o equivalente a 3 meses das suas despesas. A gente calcula pra você.',
        points: 100,
        type: 'form',
        requires: 'orc_montar',
        reserva3x: true,
        fields: [
          { id: 'valor_mes', label: 'Quanto vai guardar por mês? (R$)', type: 'number' },
          { id: 'meta', label: 'Qual sua meta total de reserva? (R$)', type: 'number' },
          { id: 'onde', label: 'Onde vai guardar?', type: 'text' },
        ],
      },
      {
        id: 'res_manter',
        title: 'Mantive a reserva por 4 semanas',
        desc: 'Comprove que guardou o valor combinado durante um mês.',
        points: 200,
        type: 'proof',
        repeatable: true,
        proofHint: 'Print do extrato ou do aplicativo mostrando o valor guardado. Pode ocultar o número da conta.',
      },
    ],
  },
  {
    id: 'objetivos',
    name: 'Objetivos',
    intro: 'Sonho com prazo e plano tem outro nome: meta.',
    missions: [
      {
        id: 'obj_criar',
        title: 'Crie um objetivo com prazo',
        desc: 'Algo que você quer conquistar. Pode criar mais de um — cada objetivo novo pontua.',
        points: 100,
        type: 'form',
        repeatable: true,
        fields: [
          { id: 'objetivo', label: 'Qual é o objetivo?', type: 'text' },
          { id: 'custo', label: 'Quanto custa, aproximadamente? (R$)', type: 'number' },
          { id: 'ja_tem', label: 'Quanto você já tem guardado? (R$)', type: 'number' },
          { id: 'prazo_meses', label: 'Em quantos meses quer alcançar?', type: 'number' },
          { id: 'por_mes', label: 'Quanto consegue guardar por mês? (R$)', type: 'number' },
        ],
      },
      {
        id: 'obj_atingir',
        title: 'Alcancei meu objetivo',
        desc: 'Comprove que chegou lá. Essa é das maiores pontuações do programa.',
        points: 250,
        type: 'proof',
        repeatable: true,
        proofHint: 'Envie um comprovante do objetivo alcançado.',
      },
    ],
  },
  {
    id: 'habitos',
    name: 'Hábitos',
    intro: 'Constância vale mais que intensidade — que nem escovar os dentes.',
    missions: [
      {
        id: 'hab_checkin',
        title: 'Check-in semanal',
        desc: 'Conte como foi sua semana no dinheiro. Uma vez por semana.',
        points: 15,
        type: 'checkin',
        repeatable: true,
        fields: [
          { id: 'como_foi', label: 'Como foi sua semana financeira?', type: 'select', options: ['Melhor que o esperado', 'Dentro do planejado', 'Difícil'] },
          { id: 'comentario', label: 'Quer comentar algo?', type: 'textarea' },
        ],
      },
    ],
  },
];

// Bônus de sequência: a cada 4 check-ins seguidos, ganha um extra.
export const STREAK_BONUS = { every: 4, points: 60 };

export function findMission(missionId) {
  for (const t of TRACKS) {
    const m = t.missions.find(x => x.id === missionId);
    if (m) return { track: t, mission: m };
  }
  return null;
}

// Catálogo sem as respostas do quiz (é o que vai para o navegador).
export function publicCatalog() {
  return TRACKS.map(t => ({
    ...t,
    missions: t.missions.map(m => {
      const { questions, ...rest } = m;
      if (!questions) return rest;
      return {
        ...rest,
        questions: questions.map(q => ({ q: q.q, options: q.options })),
      };
    }),
  }));
}

// Módulos base (sempre liberados).
export const BASE_MODULES = TRACKS.filter(t => t.base).map(t => t.id);

// Pontos-padrão de bônus por módulo (o gestor pode alterar no painel).
export const DEFAULT_MODULE_POINTS = {
  diagnostico: 0, orcamento: 0, dividas: 150, cartao: 120,
  reserva: 150, objetivos: 120, habitos: 100,
};

// Um módulo está liberado para a pessoa?
export function moduleUnlocked(trackId, user) {
  if (BASE_MODULES.includes(trackId)) return true;
  return !!(user && user.modules && user.modules[trackId]);
}

// Catálogo já filtrado pelos módulos que a pessoa tem liberados.
export function catalogFor(user) {
  return publicCatalog().filter(t => moduleUnlocked(t.id, user));
}

// Versão do colaborador segura para enviar ao navegador (sem salt/hash do PIN).
export function publicUser(u) {
  return {
    matricula: u.matricula,
    nome: u.nome,
    points: u.points || 0,
    done: u.done || {},
    lessonsDone: u.lessonsDone || {},
    streak: u.streak || 0,
    lastCheckin: u.lastCheckin || null,
    createdAt: u.createdAt || null,
    level: levelFor(u.points || 0),
  };
}
