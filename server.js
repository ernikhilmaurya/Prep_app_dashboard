const express = require("express");
const crypto = require("crypto");
const session = require("express-session");
const { Pool } = require("pg");
const { body, validationResult } = require("express-validator");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 4000;

// Behind nginx (TLS terminates there, proxies to this app over plain HTTP).
// Without this, express-session sees req.secure === false and silently
// drops the Set-Cookie header whenever cookie.secure is true.
app.set("trust proxy", 1);

// PostgreSQL connection pool
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
});

app.use(express.json({ limit: "50mb" }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: process.env.HTTPS==="true",
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: "Unauthorized" });
}

app.post("/login", (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  req.session.authenticated = true;
  res.json({ success: true });
});

app.get("/auth-status", (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.post("/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.use(express.static(__dirname));

// Serve index.html
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

function calculateReadTime(text) {
  if (!text) return 0;
  const wordsPerMinute = 200;
  const words = text.split(/\s+/).length;
  return Math.ceil(words / wordsPerMinute);
}

async function insertArticle(client, data) {
  const analysis = data.analysis || {};

  const articleQuery = `
    INSERT INTO articles (
      title, content, category, sub_category, tags,
      read_time, gs_papers, source, published_at, image_url,
      news_summary, why_it_matters, real_life_example,
      syllabus_topics, related_micro_topics,
      relevance_score, relevance_reason, type
    )
    VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,$9,$10,
      $11,$12,$13,
      $14,$15,$16,$17,$18
    )
    RETURNING id
    `;

  const values = [
    data.title,
    analysis.original_news_summary || "",
    analysis.subjects?.[0] || "General",
    analysis.subjects?.[1] || null,
    analysis.related_micro_topics || [],
    calculateReadTime(analysis.original_news_summary),
    analysis.gs_paper ? analysis.gs_paper.split(",").map((s) => s.trim()) : [],
    data.source,
    new Date(),
    null,
    analysis.original_news_summary,
    analysis.why_this_matters_for_india,
    analysis.example_for_understanding,
    analysis.syllabus_topics || [],
    analysis.related_micro_topics || [],
    data.score || 0,
    data.reason || "",
    data.type?.trim().toLowerCase() === "editorial" ? "editorial" : "article",
  ];

  const result = await client.query(articleQuery, values);
  const articleId = result.rows[0].id;

  if (Array.isArray(analysis.core_concepts)) {
    for (const concept of analysis.core_concepts) {
      await client.query(
        `
        INSERT INTO article_core_concepts
        (
          article_id,
          concept_name,
          definition,
          key_points,
          constitutional_links,
          why_important
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [
          articleId,
          concept.concept,
          concept.definition,
          concept.key_points || [],
          concept.constitutional_or_institutional_links || [],
          concept.why_it_is_important,
        ],
      );

      await client.query(
        `
          INSERT INTO article_keywords
          (
            article_id,
            keyword,
            definition,
            related_article_paragraph
          )
          VALUES ($1, $2, $3, $4)
          `,
        [articleId, concept.concept, concept.definition, null],
      );
      await client.query(
        `
        INSERT INTO article_prelims_concepts
        (
          article_id,
          concept_name,
          key_facts
        )
        VALUES ($1,$2,$3)
        `,
        [articleId, concept.concept, concept.key_points || []],
      );
    }
  }

  if (Array.isArray(data.analysis.data_reports_committees)) {
    for (const report of analysis.data_reports_committees) {
      await client.query(
        `
      INSERT INTO article_data_reports
      (
        article_id,
        name,
        report_type,
        explanation
      )
      VALUES ($1,$2,$3,$4)
      `,
        [
          articleId,
          report.name,
          report.report_type || null,
          report.explanation || null,
        ],
      );
    }
  }

  if (analysis.mains_practice_question) {
    const question = analysis.mains_practice_question;
    const hints = question.answer_hints || {};
    await client.query(
      `
        INSERT INTO article_mains_questions
        (
          article_id,
          question_text,
          introduction_hint,
          body_dimensions,
          conclusion_hint
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
      [
        articleId,
        question.question,
        hints.introduction,
        hints.body_dimensions || [],
        hints.conclusion_way_forward,
      ],
    );
  }

  return articleId;
}

app.post(
  "/add-article",
  requireAuth,
  [body("title").notEmpty(), body("source").notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const data = req.body;
      const articleId = await insertArticle(client, data);

      await client.query("COMMIT");

      res.json({
        success: true,
        article_id: articleId,
      });
    } catch (err) {
      await client.query("ROLLBACK");

      console.error("Insert error:", err);

      res.status(500).json({
        error: "Insert failed",
        message: err.message,
      });
    } finally {
      client.release();
    }
  },
);

app.post("/add-articles", requireAuth, async (req, res) => {
  const articles = req.body.top_upsc_news;
  if (!Array.isArray(articles)) {
    return res
      .status(400)
      .json({ error: 'Invalid format. "top_upsc_news" should be an array.' });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertedIds = [];
    for (const articleData of articles) {
      const articleId = await insertArticle(client, articleData);
      insertedIds.push(articleId);
    }

    await client.query("COMMIT");
    res.json({ success: true, article_ids: insertedIds });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Bulk insert error:", err);
    res.status(500).json({ error: "Bulk insert failed", message: err.message });
  } finally {
    client.release();
  }
});

app.post("/add-quizzes", requireAuth, async (req, res) => {
  // Accept raw array format
  const quizzes = Array.isArray(req.body) ? req.body : req.body.quizzes;
  if (!Array.isArray(quizzes)) {
    return res
      .status(400)
      .json({ error: "Invalid format. Expected a JSON array of quiz objects." });
  }

  const client = await pool.connect();
  try {
    // NOTE: this used to TRUNCATE the entire quizzes table on every upload,
    // which wiped every past article's quizzes each time a new day's batch
    // was submitted — only the most recently uploaded day ever had quiz data.
    // Fixed to scope the replace to just the articles in this batch (below),
    // so re-uploading a correction for one day no longer destroys every
    // other day's quizzes.
    let totalRows = 0;
    let skipped = 0;
    const warnings = [];

    for (const entry of quizzes) {
      const newsTitle = entry.news_title;

      // Resolve article_id by exact title match — pick latest if duplicates exist
      const { rows } = await client.query(
        `SELECT id FROM articles
         WHERE LOWER(TRIM(title)) = LOWER(TRIM($1))
         ORDER BY published_at DESC NULLS LAST, id DESC
         LIMIT 1`,
        [newsTitle]
      );

      let matchedRows = rows;

      if (matchedRows.length === 0) {
        // Try partial match for truncated titles — pick latest match
        const { rows: partial } = await client.query(
          `SELECT id, title FROM articles
           WHERE LOWER(title) LIKE LOWER($1)
           ORDER BY published_at DESC NULLS LAST, id DESC
           LIMIT 1`,
          [`%${newsTitle.slice(0, 30)}%`]
        );
        if (partial.length === 0) {
          const msg = `No article found for quiz: "${newsTitle.slice(0, 60)}"`;
          warnings.push(msg);
          skipped++;
          continue;
        }
        matchedRows = partial;
        warnings.push(`Partial match used: "${partial[0].title.slice(0, 60)}" for "${newsTitle.slice(0, 60)}"`);
      }

      const article_id = matchedRows[0].id;
      const difficulties = ["easy", "medium", "hard"];

      // Replace only this article's own quiz rows — re-submitting a
      // correction for one article must not touch any other article's data.
      await client.query(`DELETE FROM quizzes WHERE article_id = $1`, [article_id]);

      for (const difficulty of difficulties) {
        const questions = entry.quiz[difficulty] || [];
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          await client.query(
            `INSERT INTO quizzes
               (article_id, question_type, question_text, options, correct_answer, explanation, question_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              article_id,
              difficulty,
              q.question,
              JSON.stringify(q.options),
              q.answer,
              q.explanation || null,
              i + 1,
            ]
          );
          totalRows++;
        }
      }
    }

    res.json({
      success: true,
      inserted: totalRows,
      skipped,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (err) {
    console.error("Quiz insert error:", err);
    res.status(500).json({ error: "Quiz insert failed", message: err.message });
  } finally {
    client.release();
  }
});

app.post("/add-mapped-syllabus", requireAuth, async (req, res) => {
  // Accept raw array format
  const data = Array.isArray(req.body) ? req.body : req.body.data;
  if (!Array.isArray(data)) {
    return res
      .status(400)
      .json({ error: "Invalid format. Expected a JSON array of syllabus objects." });
  }

  const client = await pool.connect();
  try {
    // Ensure table exists without dropping existing data
    await client.query(`
      CREATE TABLE IF NOT EXISTS mapped_syllabus (
        id           SERIAL PRIMARY KEY,
        article_id   INTEGER REFERENCES articles(id),
        rank         INTEGER NOT NULL,
        title        TEXT    NOT NULL,
        sub_topic    TEXT    NOT NULL,
        micro_topics TEXT[]  NOT NULL DEFAULT '{}'
      )
    `);

    let totalRows = 0;
    let skipped = 0;
    const warnings = [];

    for (const article of data) {
      // Resolve ALL article_ids matching this title (handles duplicate inserts)
      const { rows } = await client.query(
        "SELECT id FROM articles WHERE LOWER(TRIM(title)) = LOWER(TRIM($1))",
        [article.title]
      );
      let articleIds = rows.map((r) => r.id);

      if (articleIds.length === 0) {
        // Try partial match
        const { rows: similar } = await client.query(
          `SELECT id, title FROM articles WHERE LOWER(title) LIKE LOWER($1) LIMIT 1`,
          [`%${article.title.slice(0, 20)}%`]
        );
        if (similar.length > 0) {
          articleIds = [similar[0].id];
          warnings.push(`Partial match used: "${similar[0].title.slice(0, 60)}" for "${article.title.slice(0, 60)}"`);
        } else {
          warnings.push(`No article found for: "${article.title.slice(0, 60)}"`);
          skipped++;
          continue;
        }
      }

      for (const id of articleIds) {
        // Replace this article's own mapping rows — re-submitting a
        // correction must not accumulate duplicates on top of the old set.
        await client.query(`DELETE FROM mapped_syllabus WHERE article_id = $1`, [id]);

        for (const entry of article.sub_topics) {
          await client.query(
            `INSERT INTO mapped_syllabus (article_id, rank, title, sub_topic, micro_topics)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, article.rank, article.title, entry.sub_topic, entry.micro_topics]
          );
          totalRows++;
        }
      }
    }

    res.json({
      success: true,
      inserted: totalRows,
      skipped,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (err) {
    console.error("Mapped syllabus insert error:", err);
    res.status(500).json({ error: "Insert failed", message: err.message });
  } finally {
    client.release();
  }
});

app.post("/add-revision-concepts", requireAuth, async (req, res) => {
  // Accept raw array format
  const concepts = Array.isArray(req.body) ? req.body : req.body.data ? req.body.data : [req.body];

  if (!concepts.length || !concepts[0].micro_concept) {
    return res.status(400).json({ error: "Invalid format. Expected a JSON array of revision concept objects with a 'micro_concept' field." });
  }

  const client = await pool.connect();
  try {
    let inserted = 0;
    let skipped = 0;
    const warnings = [];

    // Pass 1: resolve article_id for every concept first. Several concepts
    // in the same batch commonly share one article_id (multiple micro
    // concepts per news item) — resolving up front lets us replace each
    // article's old rows exactly once, instead of a naive per-row delete
    // that would wipe out an earlier concept from this same batch.
    const resolved = [];
    const articleIdsInBatch = new Set();
    for (const c of concepts) {
      let article_id = null;
      if (c.news_title) {
        const { rows } = await client.query(
          `SELECT id FROM articles
           WHERE LOWER(TRIM(title)) = LOWER(TRIM($1))
           ORDER BY published_at DESC NULLS LAST, id DESC
           LIMIT 1`,
          [c.news_title]
        );
        if (rows.length > 0) {
          article_id = rows[0].id;
        } else {
          const { rows: partial } = await client.query(
            `SELECT id FROM articles
             WHERE LOWER(title) LIKE LOWER($1)
             ORDER BY published_at DESC NULLS LAST, id DESC
             LIMIT 1`,
            [`%${c.news_title.slice(0, 30)}%`]
          );
          if (partial.length > 0) {
            article_id = partial[0].id;
            warnings.push(`Partial article match used for concept: "${c.micro_concept}"`);
          } else {
            warnings.push(`No article found for concept: "${c.micro_concept}" (news: "${c.news_title?.slice(0, 60)}")`);
          }
        }
      }
      if (article_id) articleIdsInBatch.add(article_id);
      resolved.push({ c, article_id });
    }

    // Pass 2: replace each affected article's rows once, then insert.
    if (articleIdsInBatch.size > 0) {
      await client.query(`DELETE FROM revision_concepts WHERE article_id = ANY($1::int[])`, [
        [...articleIdsInBatch],
      ]);
    }

    for (const { c, article_id } of resolved) {
      await client.query(
        `INSERT INTO revision_concepts
           (article_id, news_id, news_title, news_source, news_date, news_rank, news_score,
            micro_concept, is_new, concept_angle, trigger, mechanism, prelims_trap, insight)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          article_id,
          c.news_id || null,
          c.news_title || null,
          c.news_source || null,
          c.news_date || null,
          c.news_rank || null,
          c.news_score || null,
          c.micro_concept,
          c.is_new ?? false,
          JSON.stringify(c.concept_angle || {}),
          c.trigger || null,
          c.mechanism || null,
          JSON.stringify(c.prelims_trap || {}),
          c.insight || null,
        ]
      );
      inserted++;
    }

    res.json({
      success: true,
      inserted,
      skipped,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (err) {
    console.error("Revision concept insert error:", err);
    res.status(500).json({ error: "Insert failed", message: err.message });
  } finally {
    client.release();
  }
});

app.post("/add-keyword-glossary", requireAuth, async (req, res) => {
  // Accept raw array format or { keyword_glossary: [...] }
  const entries = Array.isArray(req.body)
    ? req.body
    : req.body.keyword_glossary;

  if (!Array.isArray(entries)) {
    return res.status(400).json({
      error: 'Invalid format. Expected a JSON array or an object with a "keyword_glossary" array.',
    });
  }

  const client = await pool.connect();
  try {
    // Ensure table exists without dropping existing data
    await client.query(`
      CREATE TABLE IF NOT EXISTS keyword_glossary (
        id          SERIAL PRIMARY KEY,
        article_id  INTEGER REFERENCES articles(id),
        news_title  TEXT,
        term        TEXT NOT NULL,
        explanation TEXT
      )
    `);

    let inserted = 0;
    let skipped = 0;
    const warnings = [];

    for (const entry of entries) {
      const newsTitle = entry.title;
      const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];

      // Resolve article_id by exact title match — pick latest if duplicates exist
      let article_id = null;
      if (newsTitle) {
        const { rows } = await client.query(
          `SELECT id FROM articles
           WHERE LOWER(TRIM(title)) = LOWER(TRIM($1))
           ORDER BY published_at DESC NULLS LAST, id DESC
           LIMIT 1`,
          [newsTitle]
        );

        if (rows.length > 0) {
          article_id = rows[0].id;
        } else {
          const { rows: partial } = await client.query(
            `SELECT id, title FROM articles
             WHERE LOWER(title) LIKE LOWER($1)
             ORDER BY published_at DESC NULLS LAST, id DESC
             LIMIT 1`,
            [`%${newsTitle.slice(0, 30)}%`]
          );
          if (partial.length > 0) {
            article_id = partial[0].id;
            warnings.push(`Partial match used: "${partial[0].title.slice(0, 60)}" for "${newsTitle.slice(0, 60)}"`);
          } else {
            warnings.push(`No article found for: "${newsTitle.slice(0, 60)}"`);
          }
        }
      }

      // Replace this article's own glossary rows — re-submitting a
      // correction must not accumulate duplicates on top of the old set.
      // (article_id can be null when no article matched — nothing to key
      // a replace on in that case, so just insert as before.)
      if (article_id) {
        await client.query(`DELETE FROM keyword_glossary WHERE article_id = $1`, [article_id]);
      }

      for (const kw of keywords) {
        if (!kw.term) {
          skipped++;
          continue;
        }
        await client.query(
          `INSERT INTO keyword_glossary (article_id, news_title, term, explanation)
           VALUES ($1, $2, $3, $4)`,
          [article_id, newsTitle || null, kw.term, kw.explanation || null]
        );
        inserted++;
      }
    }

    res.json({
      success: true,
      inserted,
      skipped,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (err) {
    console.error("Keyword glossary insert error:", err);
    res.status(500).json({ error: "Insert failed", message: err.message });
  } finally {
    client.release();
  }
});

// Catch-all error handler — ensures Express 5 never returns an HTML error page
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:4000`);
});
