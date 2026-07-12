import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse body — handles both pre-parsed object and raw string
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  const { action, table, id, data, fields, order, limit, offset, orderField } = body || req.query;

  try {
    // SELECT
    if (req.method === 'GET' || action === 'select') {
      const t = sanitizeTable(table);
      const lim = parseInt(limit) || 1000;
      const off = parseInt(offset) || 0;
      const ord = sanitizeField(orderField || 'created_at');
      const asc = order === 'asc' ? 'ASC' : 'DESC';
      const rows = await sql(`SELECT * FROM ${t} ORDER BY ${ord} ${asc} LIMIT ${lim} OFFSET ${off}`);
      return res.json({ data: rows, error: null });
    }

    // INSERT
    if (action === 'insert') {
      const t = sanitizeTable(table);
      const keys = Object.keys(data);
      const vals = Object.values(data);
      const cols = keys.map(k => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await sql(`INSERT INTO ${t} (${cols}) VALUES (${placeholders}) RETURNING *`, vals);
      return res.json({ data: rows[0], error: null });
    }

    // UPDATE
    if (action === 'update') {
      const t = sanitizeTable(table);
      const keys = Object.keys(fields);
      const vals = keys.map(v => {
        const val = fields[v];
        // Serialize arrays/objects to JSON string for JSONB columns
        if (Array.isArray(val) || (val !== null && typeof val === 'object')) {
          return JSON.stringify(val);
        }
        return val;
      });
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      vals.push(id);
      await sql(`UPDATE ${t} SET ${sets} WHERE id = $${vals.length}`, vals);
      return res.json({ data: null, error: null });
    }

    // UPSERT
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

    // DELETE
    if (action === 'delete') {
      const t = sanitizeTable(table);
      await sql(`DELETE FROM ${t} WHERE id = $1`, [id]);
      return res.json({ data: null, error: null });
    }

    return res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error('DB error:', e.message, e.stack);
    return res.status(500).json({ data: null, error: e.message });
  }
}

const ALLOWED_TABLES = ['fichas_triagem', 'terapeutas', 'agendamentos', 'admin_notificacoes', 'fichas_casal'];
const ALLOWED_FIELDS = ['created_at', 'date', 'id', 'nome', 'status', 'updated_at'];

function sanitizeTable(t) {
  if (!ALLOWED_TABLES.includes(t)) throw new Error('Tabela não permitida: ' + t);
  return `public."${t}"`;
}
function sanitizeField(f) {
  if (!ALLOWED_FIELDS.includes(f)) return '"created_at"';
  return `"${f}"`;
}
