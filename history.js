// ============================================================================
//  Acesso ao histórico de conversas (uso administrativo — Marco Souza).
//  Protegido por senha (variável de ambiente ADMIN_PASSWORD na Vercel).
//  Usado pela página /historico.html.
//    GET /api/history            → lista as conversas (mais recentes primeiro)
//    GET /api/history?id=XXXX    → retorna a conversa completa
//  A senha vai no cabeçalho "x-admin-key".
// ============================================================================
const REDIS_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error('Redis ' + r.status);
  const j = await r.json();
  return j.result;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return res.status(500).json({ error: 'Defina ADMIN_PASSWORD nas variáveis de ambiente da Vercel.' });
  }

  const provided = req.headers['x-admin-key'] || (req.query && req.query.key);
  if (provided !== adminPassword) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'Banco de dados não configurado. Instale o Upstash Redis pelo Marketplace da Vercel.' });
  }

  try {
    const id = req.query && req.query.id;

    // Conversa específica
    if (id) {
      const raw = await redis(['GET', `conv:${id}`]);
      if (!raw) return res.status(404).json({ error: 'Conversa não encontrada.' });
      return res.status(200).json({ conversation: JSON.parse(raw) });
    }

    // Lista das 200 conversas mais recentes
    const ids = await redis(['ZREVRANGE', 'idx:conversations', '0', '199']);
    if (!ids || ids.length === 0) {
      return res.status(200).json({ conversations: [] });
    }

    const keys = ids.map(cid => `conv:${cid}`);
    const rows = await redis(['MGET', ...keys]);

    const conversations = (rows || []).map(raw => {
      if (!raw) return null;
      let rec;
      try { rec = JSON.parse(raw); } catch { return null; }
      const msgs = Array.isArray(rec.messages) ? rec.messages : [];
      const firstUser = msgs.find(m => m.role === 'user');
      return {
        id: rec.id,
        updatedAt: rec.updatedAt || 0,
        count: msgs.length,
        preview: firstUser ? firstUser.content.slice(0, 120) : '(sem mensagem)',
      };
    }).filter(Boolean);

    return res.status(200).json({ conversations });
  } catch (err) {
    console.error('Erro ao ler histórico:', err);
    return res.status(500).json({ error: 'Erro ao consultar o banco de dados.' });
  }
}
