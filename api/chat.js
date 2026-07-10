// ============================================================================
//  Função de servidor (Vercel) — conversa com o GPT sem expor a sua chave.
//  A interface (index.html) envia as mensagens para este arquivo em /api/chat,
//  e ele repassa para a API da OpenAI junto com o SEU prompt.
// ============================================================================

// ┌──────────────────────────────────────────────────────────────────────────┐
// │  👉  COLE O SEU PROMPT ABAIXO, entre as crases (` `).                       │
// │  Ele define a "personalidade" e as regras do assistente de finanças.       │
// └──────────────────────────────────────────────────────────────────────────┘
const SYSTEM_PROMPT = `
Você é um assistente de educação e planejamento financeiro pessoal para brasileiros.
Seu papel é orientar de forma clara, acolhedora e prática sobre orçamento, controle de
gastos, quitação de dívidas, reserva de emergência e primeiros passos em investimentos.

Regras:
- Use linguagem simples e explique termos técnicos.
- Faça perguntas quando faltar informação para dar uma orientação útil.
- Ofereça passos concretos e realistas para a realidade brasileira (ex.: Selic, CDI,
  Tesouro Direto, PIX, cartão de crédito rotativo).
- Não recomende ativos específicos nem prometa retornos. Deixe claro que são orientações
  educativas, e não consultoria de investimento individual.

[SUBSTITUA ESTE TEXTO PELO SEU PROMPT COMPLETO.]
`;
// ── fim do prompt ───────────────────────────────────────────────────────────

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Chave da API não configurada. Defina OPENAI_API_KEY nas variáveis de ambiente da Vercel.'
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = body && Array.isArray(body.messages) ? body.messages : null;

    if (!messages) {
      return res.status(400).json({ error: 'Formato de mensagens inválido.' });
    }

    // Mantém apenas os campos esperados e limita o histórico para conter custos.
    const clean = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content.slice(0, 6000) }));

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...clean],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Erro da OpenAI:', response.status, detail);
      return res.status(502).json({
        error: 'O serviço do GPT retornou um erro. Verifique a chave da API e os créditos da sua conta OpenAI.'
      });
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || '';
    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Erro interno:', err);
    return res.status(500).json({ error: 'Erro interno ao processar a solicitação.' });
  }
}
