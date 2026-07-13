import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
      return res.json({ data: rows, error: null });
    }

    if (action === 'insert') {
      const t = sanitizeTable(table);
      const keys = Object.keys(data);
      const vals = Object.values(data);
      const cols = keys.map(k => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await sql(`INSERT INTO ${t} (${cols}) VALUES (${placeholders}) RETURNING *`, vals);
      return res.json({ data: rows[0], error: null });
    }

    if (action === 'update') {
      const t = sanitizeTable(table);
      const keys = Object.keys(fields);
      const vals = keys.map(k => {
        const v = fields[k];
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
            const v = fields[k];
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
      const keys = Object.keys(data);
      const vals = Object.values(data);
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

function sanitizeTable(t) {
  if (!ALLOWED_TABLES.includes(t)) throw new Error('Tabela não permitida: ' + t);
  return `public."${t}"`;
}
function sanitizeField(f) {
  if (!ALLOWED_FIELDS.includes(f)) return '"created_at"';
  return `"${f}"`;
}
