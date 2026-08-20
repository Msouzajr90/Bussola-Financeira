// ============================================================================
//  Backup automático diário — chamado pelo Vercel Cron (ver vercel.json).
//  Gera um snapshot completo do banco e guarda os últimos 7 dias no Redis.
// ============================================================================
import { saveBackupSnapshot, dbReady } from '../lib/store.js';

export default async function handler(req, res) {
  // Segurança: se CRON_SECRET estiver configurado, exige o header do Vercel Cron.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }
  }

  if (!dbReady) return res.status(500).json({ error: 'Banco de dados não configurado.' });

  try {
    const r = await saveBackupSnapshot();
    return res.status(200).json({ ok: true, ...r });
  } catch (err) {
    console.error('cron-backup:', err);
    return res.status(500).json({ error: 'Falha ao gerar o backup diário.' });
  }
}
