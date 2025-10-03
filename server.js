import "dotenv/config";
import express from "express";
import mysql from "mysql2/promise";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors({ origin: "http://localhost:4200" }));

// Connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
});

// [NYTT] Visa vilket schema som lästs in
console.log("Using database:", process.env.DB_NAME);

// Hjälp: säkert ut JSON_ARRAYAGG-resultat oavsett driver-return (sträng vs objekt)
function asJsonArray(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === "object") return val; // mysql2 kan ge native objekt/array
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return [];
    }
  }
  return [];
}

// Hjälpfunktion: formatera varje rad till stabil nyckelordning
function mapGlossaryRow(x) {
  return {
    term: x?.term ?? null,
    definition: x?.definition ?? null,
    domain: x?.domain ?? null,
    kind: x?.kind ?? null,
    courses: Array.isArray(x?.courses)
      ? x.courses.map((c) => ({
          title: c?.title ?? null,
          short_form: c?.short_form ?? null,
          hve_credits: c?.hve_credits ?? null,
          weblink: c?.weblink ?? null,
        }))
      : [],
    weblinks: Array.isArray(x?.weblinks)
      ? x.weblinks
      : x?.weblinks
      ? [x.weblinks]
      : [],
  };
}

// Bas-sql som bygger varje glosa med inbäddade courses + weblinks
const BASE_SQL = `
  SELECT JSON_ARRAYAGG(
           JSON_OBJECT(
             'term', g.term,
             'definition', g.definition,
             'domain', dd.name,
             'kind', dk.name,
             'courses', (
               SELECT JSON_ARRAYAGG(course_obj)
               FROM (
                 SELECT JSON_OBJECT(
                          'title', c.title,
                          'short_form', c.short_form,
                          'hve_credits', c.hve_credits,
                          'weblink', w2.path
                        ) AS course_obj
                 FROM glossary_course gc
                 JOIN course c ON c.id = gc.course_id
                 LEFT JOIN course_weblink cw ON cw.course_id = c.id
                 LEFT JOIN weblink w2 ON w2.id = cw.weblink_id
                 WHERE gc.glossary_id = g.id
                 ORDER BY c.title, w2.path
               ) AS ordered_courses
             ),
             'weblinks', (
               SELECT JSON_ARRAYAGG(path)
               FROM (
                 SELECT w.path AS path
                 FROM glossary_weblink gw
                 JOIN weblink w ON w.id = gw.weblink_id
                 WHERE gw.glossary_id = g.id
                 ORDER BY w.path
               ) AS ordered_glossary_links
             )
           )
         ) AS data
  FROM glossary g
  LEFT JOIN glossary_domain  gd ON gd.glossary_id = g.id
  LEFT JOIN category_dim_domain dd ON dd.id = gd.domain_id
  LEFT JOIN glossary_kind   gk ON gk.glossary_id = g.id
  LEFT JOIN category_dim_kind  dk ON dk.id = gk.kind_id
`;

// GET /api/glossary?domain=React&kind=Bibliotek&q=handle&page=1&limit=50
app.get("/api/glossary", async (req, res) => {
  try {
    const { domain, kind, q, page = "1", limit = "100" } = req.query;

    // Vi filtrerar i en yttre SELECT för att kunna paginera deterministiskt på term
    const filters = [];
    const params = {};

    if (domain) {
      filters.push(`dd.name = :domain`);
      params.domain = String(domain);
    }
    if (kind) {
      filters.push(`dk.name = :kind`);
      params.kind = String(kind);
    }
    if (q) {
      filters.push(`g.term LIKE :q`);
      params.q = `%${String(q)}%`;
    }

    if (req.query.course) {
      filters.push(`
    EXISTS (
      SELECT 1
      FROM glossary_course gc
      JOIN course c ON c.id = gc.course_id
      WHERE gc.glossary_id = g.id
        AND c.title = :course
    )
  `);
      params.course = String(req.query.course);
    }

    // Bygg inre lista på id:n (stabil sortering på term)
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.max(
      1,
      Math.min(500, parseInt(String(limit), 10) || 100)
    );
    const offset = (pageNum - 1) * limitNum;

    const WHERE = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const idSql = `
      SELECT g.id
      FROM glossary g
      LEFT JOIN glossary_domain  gd ON gd.glossary_id = g.id
      LEFT JOIN category_dim_domain dd ON dd.id = gd.domain_id
      LEFT JOIN glossary_kind   gk ON gk.glossary_id = g.id
      LEFT JOIN category_dim_kind  dk ON dk.id = gk.kind_id
      ${WHERE}
      ORDER BY g.term
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const countSql = `
      SELECT COUNT(DISTINCT g.id) AS total
      FROM glossary g
      LEFT JOIN glossary_domain  gd ON gd.glossary_id = g.id
      LEFT JOIN category_dim_domain dd ON dd.id = gd.domain_id
      LEFT JOIN glossary_kind   gk ON gk.glossary_id = g.id
      LEFT JOIN category_dim_kind  dk ON dk.id = gk.kind_id
      ${WHERE}
    `;

    const conn = await pool.getConnection();
    try {
      const [countRows] = await conn.execute(countSql, { ...params });
      const total = Number(countRows?.[0]?.total ?? 0);

      const [idRows] = await conn.execute(idSql, { ...params });
      const ids = idRows.map((r) => r.id);
      if (ids.length === 0) {
        return res.json({ total, page: pageNum, limit: limitNum, data: [] });
      }

      // Kör BASE_SQL men begränsa till dessa id:n
      const sql = `
        ${BASE_SQL}
        WHERE g.id IN (${ids.map(() => "?").join(", ")})
      `;
      const [rows] = await conn.query(sql, ids);
      const raw = asJsonArray(rows?.[0]?.data);
      const data = raw
        .map(mapGlossaryRow)
        .sort((a, b) => (a.term || "").localeCompare(b.term || "", "sv"));

      res.json({ total, page: pageNum, limit: limitNum, data });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/glossary/:term  (exakt match på term)
app.get("/api/glossary/:term", async (req, res) => {
  try {
    const { term } = req.params;
    const [rows] = await pool.query(`${BASE_SQL} WHERE TRIM(g.term) = ?`, [
      term.trim(),
    ]);
    const raw = asJsonArray(rows?.[0]?.data);
    if (raw.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }
    const obj = mapGlossaryRow(raw[0]);
    res.json(obj);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

// [NYTT] Healthcheck som visar aktivt schema
app.get("/health/db", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT DATABASE() AS db");
    res.json({ ok: true, database: rows[0]?.db ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "DB check failed" });
  }
});

const port = Number(process.env.PORT || 3000);

// [NYTT] Starta servern + gör DB-check med async/await (ingen .then)
(async function start() {
  try {
    const [rows] = await pool.query("SELECT DATABASE() AS db");
    console.log("Current schema:", rows[0]?.db);
  } catch (err) {
    console.error("DB check failed at startup:", err);
  }

  app.listen(port, () =>
    console.log(`API listening on http://localhost:${port}`)
  );
})();

/*
endpoints:
# Hämta allt (paginering default: page=1, limit=100)
http://localhost:3000/api/glossary

# Filtrera
http://localhost:3000/api/glossary?domain=Node&kind=Template-motor

# Sök på term
http://localhost:3000/api/glossary?q=handle

# En enda term (exakt)
http://localhost:3000/api/glossary/Handlebars
*/

// http://localhost:3000/api/glossary?course=Backend%20programming%20in%20Node.js

// i frontend gå till
// http://localhost:4200/?course=Backend%20programming%20in%20Node.js
