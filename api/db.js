import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const sql = neon(process.env.DATABASE_URL);
const AUTH_SECRET = process.env.AUTH_SECRET;

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !AUTH_SECRET) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
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

// Remove a senha de qualquer linha de terapeuta antes de devolver ao cliente —
// a senha nunca deve trafegar para o navegador, nem em hash.
function stripPassword(table, rows) {
  if (table !== 'terapeutas') return rows;
  return rows.map(r => { const { password, ...rest } = r; return rest; });
}

// Se o payload de um terapeuta incluir "password", garante que é gravado com hash.
async function hashPasswordIfPresent(table, obj) {
  if (table !== 'terapeutas' || !obj || typeof obj.password === 'undefined' || obj.password === null || obj.password === '') return obj;
  if (isHashed(obj.password)) return obj; // já veio em hash (idempotente, evita re-hash)
  return { ...obj, password: await bcrypt.hash(String(obj.password), 10) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!AUTH_SECRET) {
    console.error('AUTH_SECRET não configurado nas variáveis de ambiente do Vercel.');
    return res.status(500).json({ error: 'Configuração do servidor incompleta (AUTH_SECRET).' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const session = verifyToken(token);
  if (!session) return res.status(401).json({ error: 'Não autenticado. Faça login novamente.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  const { action, table, id, data, fields, order, limit, offset, orderField } = body || req.query;

  try {
    if (req.method === 'GET' || action === 'select') {
      const t = sanitizeTable(table);
      const lim = parseInt(limit) || 1000;
      const off = parseInt(offset) || 0;
      const ord = sanitizeField(orderField || 'created_at');
      const asc = order === 'asc' ? 'ASC' : 'DESC';
      const rows = await sql(`SELECT * FROM ${t} ORDER BY ${ord} ${asc} LIMIT ${lim} OFFSET ${off}`);
      return res.json({ data: stripPassword(table, rows), error: null });
    }

    if (action === 'insert') {
      const t = sanitizeTable(table);
      const payload = await hashPasswordIfPresent(table, data);
      const keys = Object.keys(payload).map(sanitizeColumn);
      const vals = Object.values(payload);
      const cols = keys.map(k => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await sql(`INSERT INTO ${t} (${cols}) VALUES (${placeholders}) RETURNING *`, vals);
      return res.json({ data: stripPassword(table, rows)[0], error: null });
    }

    if (action === 'update') {
      const t = sanitizeTable(table);
      const payload = await hashPasswordIfPresent(table, fields);
      const keys = Object.keys(payload).map(sanitizeColumn);
      const vals = keys.map(k => {
        const v = payload[k];
        return (Array.isArray(v) || (v !== null && typeof v === 'object')) ? JSON.stringify(v) : v;
      });
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      vals.push(id);
      const queryStr = `UPDATE ${t} SET ${sets} WHERE id = $${vals.length}`;
      try {
        await sql(queryStr, vals);
      } catch (e) {
        // Auto-migrate: if a column is missing, create it and retry
        if (e.message && e.message.includes('does not exist')) {
          for (const k of keys) {
            const v = payload[k];
            const colType = typeof v === 'boolean' ? 'BOOLEAN DEFAULT FALSE'
              : (Array.isArray(v) || (v !== null && typeof v === 'object')) ? 'JSONB'
              : 'TEXT';
            await sql(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS "${k}" ${colType}`);
          }
          await sql(queryStr, vals);
        } else { throw e; }
      }
      return res.json({ data: null, error: null });
    }

    if (action === 'upsert') {
      const t = sanitizeTable(table);
      const payload = await hashPasswordIfPresent(table, data);
      const keys = Object.keys(payload).map(sanitizeColumn);
      const vals = Object.values(payload);
      const cols = keys.map(k => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const sets = keys.filter(k => k !== 'id').map(k => `"${k}" = EXCLUDED."${k}"`).join(', ');
      await sql(`INSERT INTO ${t} (${cols}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${sets}`, vals);
      return res.json({ data: null, error: null });
    }

    if (action === 'delete') {
      const t = sanitizeTable(table);
      await sql(`DELETE FROM ${t} WHERE id = $1`, [id]);
      return res.json({ data: null, error: null });
    }

    return res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error('DB error:', e.message);
    return res.status(500).json({ data: null, error: e.message });
  }
}

const ALLOWED_TABLES = ['fichas_triagem', 'terapeutas', 'agendamentos', 'admin_notificacoes', 'fichas_casal'];
const ALLOWED_FIELDS  = ['created_at', 'date', 'id', 'nome', 'status', 'updated_at'];
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function sanitizeTable(t) {
  if (!ALLOWED_TABLES.includes(t)) throw new Error('Tabela não permitida: ' + t);
  return `public."${t}"`;
}
function sanitizeField(f) {
  if (!ALLOWED_FIELDS.includes(f)) return '"created_at"';
  return `"${f}"`;
}
// Nomes de coluna podem ser criados dinamicamente (auto-migração), então não há uma allowlist fixa —
// mas todo nome precisa bater com um identificador seguro, nunca conter aspas, ; ou espaços.
function sanitizeColumn(k) {
  if (!SAFE_IDENTIFIER.test(k)) throw new Error('Nome de campo inválido: ' + k);
  return k;
}
