import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const sql = neon(process.env.DATABASE_URL);
const AUTH_SECRET = process.env.AUTH_SECRET;
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  // comparação em tempo constante
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function isHashed(pw) {
  return typeof pw === 'string' && /^\$2[aby]\$/.test(pw);
}

function getBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!AUTH_SECRET) {
    console.error('AUTH_SECRET não configurado nas variáveis de ambiente do Vercel.');
    return res.status(500).json({ error: 'Configuração do servidor incompleta (AUTH_SECRET).' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  const { action } = body || {};

  try {
    if (action === 'verify') {
      const payload = verify(getBearer(req));
      if (!payload) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
      return res.json({ data: payload, error: null });
    }

    if (action === 'login-admin') {
      const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
      if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD não configurado no servidor.' });
      const { password } = body;
      if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Senha incorreta.' });
      const token = sign({ role: 'admin', exp: Date.now() + TOKEN_TTL_MS });
      return res.json({ data: { token }, error: null });
    }

    if (action === 'login-therapist') {
      const { username, password } = body;
      if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha.' });
      const rows = await sql(`SELECT id, username, password, bloqueado FROM public."terapeutas" WHERE lower(username) = lower($1) LIMIT 1`, [username]);
      const t = rows[0];
      if (!t) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });

      let ok;
      if (isHashed(t.password)) {
        ok = await bcrypt.compare(password, t.password);
      } else {
        // Conta legada com senha em texto puro — valida direto e já migra para hash
        ok = password === t.password;
        if (ok) {
          const newHash = await bcrypt.hash(password, 10);
          await sql(`UPDATE public."terapeutas" SET password = $1 WHERE id = $2`, [newHash, t.id]);
        }
      }
      if (!ok) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });

      const token = sign({ role: 'therapist', id: t.id, exp: Date.now() + TOKEN_TTL_MS });
      return res.json({ data: { token, id: t.id, bloqueado: !!t.bloqueado }, error: null });
    }

    if (action === 'change-password') {
      const payload = verify(getBearer(req));
      if (!payload || payload.role !== 'therapist') return res.status(401).json({ error: 'Sessão inválida.' });
      const { currentPassword, newPassword } = body;
      if (!currentPassword || !newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Dados inválidos.' });
      const rows = await sql(`SELECT password FROM public."terapeutas" WHERE id = $1`, [payload.id]);
      const t = rows[0];
      if (!t) return res.status(404).json({ error: 'Terapeuta não encontrado.' });
      const ok = isHashed(t.password) ? await bcrypt.compare(currentPassword, t.password) : currentPassword === t.password;
      if (!ok) return res.status(401).json({ error: 'Senha atual incorreta.' });
      const newHash = await bcrypt.hash(newPassword, 10);
      await sql(`UPDATE public."terapeutas" SET password = $1 WHERE id = $2`, [newHash, payload.id]);
      return res.json({ data: { ok: true }, error: null });
    }

    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (e) {
    console.error('Auth error:', e.message);
    return res.status(500).json({ data: null, error: e.message });
  }
}
