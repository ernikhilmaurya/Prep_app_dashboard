const express = require("express");
const { Pool } = require("pg");
const { body, validationResult } = require("express-validator");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 4000;

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
      relevance_score, relevance_reason
    )
    VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,$9,$10,
      $11,$12,$13,
      $14,$15,$16,$17
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

app.post("/add-articles", async (req, res) => {
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

app.post("/add-quizzes", async (req, res) => {
  const quizzes = req.body.quizzes;
  if (!Array.isArray(quizzes)) {
    return res
      .status(400)
      .json({ error: 'Invalid format. "quizzes" should be an array.' });
  }

  const client = await pool.connect();
  try {
    await client.query("TRUNCATE TABLE quizzes RESTART IDENTITY");

    let totalRows = 0;
    let skipped = 0;
    const warnings = [];

    for (const entry of quizzes) {
      // Resolve article_id by exact title match — pick latest if duplicates exist
      const { rows } = await client.query(
        `SELECT id FROM articles
         WHERE LOWER(TRIM(title)) = LOWER(TRIM($1))
         ORDER BY published_at DESC NULLS LAST, id DESC
         LIMIT 1`,
        [entry.news_title]
      );

      let matchedRows = rows;

      if (matchedRows.length === 0) {
        // Try partial match for truncated titles — pick latest match
        const { rows: partial } = await client.query(
          `SELECT id, title FROM articles
           WHERE LOWER(title) LIKE LOWER($1)
           ORDER BY published_at DESC NULLS LAST, id DESC
           LIMIT 1`,
          [`%${entry.news_title.slice(0, 30)}%`]
        );
        if (partial.length === 0) {
          const msg = `No article found for quiz: "${entry.news_title.slice(0, 60)}"`;
          warnings.push(msg);
          skipped++;
          continue;
        }
        matchedRows = partial;
        warnings.push(`Partial match used: "${partial[0].title.slice(0, 60)}" for "${entry.news_title.slice(0, 60)}"`);
      }

      const article_id = matchedRows[0].id;
      const difficulties = ["easy", "medium", "hard"];

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

app.post("/add-mapped-syllabus", async (req, res) => {
  const data = req.body.data;
  if (!Array.isArray(data)) {
    return res
      .status(400)
      .json({ error: 'Invalid format. "data" should be an array.' });
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

app.post("/add-revision-concepts", async (req, res) => {
  // Accept a single concept object or an array
  const raw = req.body;
  const concepts = Array.isArray(raw) ? raw : raw.data ? raw.data : [raw];

  if (!concepts.length || !concepts[0].concept_name) {
    return res.status(400).json({ error: "Invalid format. Provide a concept object, an array of concepts, or { data: [...] }." });
  }

  const client = await pool.connect();
  try {
    let inserted = 0;

    for (const c of concepts) {
      await client.query(
        `INSERT INTO revision_concepts
           (concept_name, concept_type, gs_paper, sub_topic, locator,
            definition, analogy_text, bridge_line, drivers, stats, institutions, qa)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          c.concept_name,
          c.concept_type,
          c.gs_paper,
          c.sub_topic,
          c.locator || null,
          c.section_1?.definition || "",
          c.section_2?.analogy_text || null,
          c.section_2?.bridge_line || null,
          JSON.stringify(c.section_5?.drivers || []),
          JSON.stringify(c.section_7?.stats || []),
          JSON.stringify(c.section_8?.institutions || []),
          JSON.stringify(c.section_9?.qa || []),
        ]
      );
      inserted++;
    }

    res.json({ success: true, inserted });
  } catch (err) {
    console.error("Revision concept insert error:", err);
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
