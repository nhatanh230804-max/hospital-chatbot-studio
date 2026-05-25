import { safeJsonParse, normalizeVietnamese } from "../utils.js";

const DEFAULT_SCHEMA_LIMIT = 8;

const STOPWORDS = new Set([
  "ai",
  "anh",
  "bao",
  "ban",
  "bi",
  "cac",
  "cai",
  "can",
  "cho",
  "co",
  "con",
  "cua",
  "dang",
  "de",
  "den",
  "duoc",
  "em",
  "gi",
  "hom",
  "hoi",
  "khong",
  "la",
  "luc",
  "minh",
  "mot",
  "nay",
  "neu",
  "ngay",
  "nhieu",
  "nhung",
  "o",
  "ra",
  "sao",
  "toi",
  "trong",
  "va",
  "ve",
  "voi",
]);

function tokenize(value) {
  return normalizeVietnamese(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function jsonArray(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function addScoreFromText(questionTokens, questionText, value, weight) {
  const text = normalizeVietnamese(value);
  if (!text) return 0;

  let score = 0;
  if (text.length >= 4 && questionText.includes(text)) {
    score += weight * 2;
  }

  const seen = new Set(tokenize(text));
  for (const token of seen) {
    if (questionTokens.has(token)) score += weight;
  }
  return score;
}

export function scoreSchemaRow(question, row) {
  const questionText = normalizeVietnamese(question);
  const questionTokens = new Set(tokenize(question));
  if (!questionText || questionTokens.size === 0) return 0;

  let score = 0;

  score += addScoreFromText(
    questionTokens,
    questionText,
    String(row.table_name || "").replaceAll("_", " "),
    10,
  );
  score += addScoreFromText(questionTokens, questionText, row.table_name, 7);
  score += addScoreFromText(questionTokens, questionText, row.domain, 8);
  score += addScoreFromText(questionTokens, questionText, row.description, 4);

  const columns = jsonArray(row.columns_json);
  for (const col of columns) {
    score += addScoreFromText(
      questionTokens,
      questionText,
      String(col.name || "").replaceAll("_", " "),
      5,
    );
    score += addScoreFromText(questionTokens, questionText, col.description, 3);
    if (Array.isArray(col.enum)) {
      for (const value of col.enum) {
        score += addScoreFromText(questionTokens, questionText, value, 4);
      }
    }
  }

  const examples = jsonArray(row.examples_json);
  for (const example of examples) {
    score += addScoreFromText(
      questionTokens,
      questionText,
      example.question,
      7,
    );
  }

  return score;
}

export function rankSchemaRows(question, rows, limit = DEFAULT_SCHEMA_LIMIT) {
  const ranked = rows
    .map((row, index) => ({
      row,
      index,
      score: scoreSchemaRow(question, row),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const positive = ranked.filter((item) => item.score > 0);
  const selected = positive.length ? positive : ranked;

  return selected.slice(0, limit).map(({ row, score }) => ({
    ...row,
    retrieval_score: score,
  }));
}
