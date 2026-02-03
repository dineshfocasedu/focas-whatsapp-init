/**
 * WATI MCQ BOT – FINAL STABLE CONTROLLER
 * ✔ No duplicate prompts
 * ✔ Real API based flow
 * ✔ Clean session handling
 */

const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

/* ========================================================= */
/* WATI SEND MESSAGE */
/* ========================================================= */

async function sendWatiSessionMessage(phone, text) {
  const { WATI_API_TOKEN, WATI_TENANT_ID, WATI_BASE_URL } = process.env;

  const url = `${WATI_BASE_URL}/${WATI_TENANT_ID}/api/v1/sendSessionMessage/${encodeURIComponent(
    phone
  )}`;

  return axios.post(url, null, {
    params: { messageText: text },
    headers: {
      Authorization: `Bearer ${WATI_API_TOKEN}`,
      Accept: "*/*",
    },
  });
}

/* ========================================================= */
/* 🔒 VERY IMPORTANT: FILTER ONLY USER MESSAGES */
/* ========================================================= */

function isIncomingUserMessage(body) {
  if (!body) return false;

  // Ignore bot/system/status messages
  if (body.isOwner === true) return false;
  if (body.message?.isOwner === true) return false;

  // Ignore non-message events
  if (body.eventType && body.eventType !== "message") return false;

  return true;
}

/* ========================================================= */
/* MOCK REDIS (replace with real redis later) */
/* ========================================================= */

const store = {};
const redis = {
  get: async k => store[k] || null,
  set: async (k, v) => (store[k] = v),
  del: async k => delete store[k],
};

const SESSION_KEY = f => `session:${f}`;

/* ========================================================= */
/* DATA API SERVICES */
/* ========================================================= */

const getSubjects = level =>
  axios
    .get("http://31.97.228.184:5555/api/data/subjects", { params: { level } })
    .then(r => r.data || []);

const getChapters = (level, subject) =>
  axios
    .get("http://31.97.228.184:5555/api/data/chapters", {
      params: { level, subject },
    })
    .then(r => r.data || []);

const getUnits = chapter =>
  axios
    .get("http://31.97.228.184:5555/api/data/units", {
      params: { chapter_name: chapter },
    })
    .then(r => (r.data || []).map(u => u.unit_name).filter(Boolean));

/* ========================================================= */
/* HELPERS */
/* ========================================================= */

const OPTIONS = {
  LEVEL: ["Foundation", "Intermediate", "Final"],
  DIFFICULTY: ["easy", "medium", "hard"],
  NUM: ["1", "5", "10"],
};

function pickOption(input, list) {
  const t = input.trim().toLowerCase();
  return list.find(o => o.toLowerCase() === t || String(list.indexOf(o) + 1) === t);
}

async function showOptions(from, title, options) {
  const msg =
    `*${title}*\n\n` +
    options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  await sendWatiSessionMessage(from, msg);
}

/* ========================================================= */
/* WEBHOOK HANDLER */
/* ========================================================= */

exports.webhookHandler = async (req, res) => {
  res.sendStatus(200);

  try {
    /** 🚫 HARD STOP DUPLICATES */
    if (!isIncomingUserMessage(req.body)) return;

    const from = req.body.from || req.body.waId;
    const text = (req.body.text || req.body.message || "").trim();

    if (!from || !text) return;

    let session = await redis.get(SESSION_KEY(from));
    session = session ? JSON.parse(session) : null;

    /* ============================= */
    /* START COMMAND */
    /* ============================= */

    if (text.toLowerCase() === "mcq") {
      session = { step: "LEVEL", data: {} };
      await redis.set(SESSION_KEY(from), JSON.stringify(session));
      await showOptions(from, "📘 Select Your Level", OPTIONS.LEVEL);
      return;
    }

    if (!session) return;

    /* ============================= */
    /* LEVEL */
    /* ============================= */

    if (session.step === "LEVEL") {
      const picked = pickOption(text, OPTIONS.LEVEL);
      if (!picked) {
        await showOptions(from, "📘 Select Your Level", OPTIONS.LEVEL);
        return;
      }

      session.data.level = picked;
      session.step = "SUBJECT";
      session.data.subjects = await getSubjects(picked);

      await redis.set(SESSION_KEY(from), JSON.stringify(session));
      await showOptions(from, "📚 Select Subject", session.data.subjects);
      return;
    }

    /* ============================= */
    /* SUBJECT */
    /* ============================= */

    if (session.step === "SUBJECT") {
      const picked = pickOption(text, session.data.subjects);
      if (!picked) {
        await showOptions(from, "📚 Select Subject", session.data.subjects);
        return;
      }

      session.data.subject = picked;
      session.step = "CHAPTER";
      session.data.chapters = await getChapters(
        session.data.level,
        picked
      );

      await redis.set(SESSION_KEY(from), JSON.stringify(session));
      await showOptions(from, "📖 Select Chapter", session.data.chapters);
      return;
    }

    /* ============================= */
    /* CHAPTER */
    /* ============================= */

    if (session.step === "CHAPTER") {
      const picked = pickOption(text, session.data.chapters);
      if (!picked) {
        await showOptions(from, "📖 Select Chapter", session.data.chapters);
        return;
      }

      session.data.chapter = picked;
      session.step = "UNIT";
      session.data.units = await getUnits(picked);

      await redis.set(SESSION_KEY(from), JSON.stringify(session));
      await showOptions(from, "📂 Select Unit or Skip", [...session.data.units, "Skip"]);
      return;
    }

    /* ============================= */
    /* UNIT */
    /* ============================= */

    if (session.step === "UNIT") {
      if (text.toLowerCase() !== "skip") {
        const picked = pickOption(text, session.data.units);
        if (!picked) {
          await showOptions(from, "📂 Select Unit or Skip", [...session.data.units, "Skip"]);
          return;
        }
        session.data.unit = picked;
      }

      session.step = "DIFFICULTY";
      await redis.set(SESSION_KEY(from), JSON.stringify(session));
      await showOptions(from, "⚡ Difficulty", OPTIONS.DIFFICULTY);
      return;
    }

    /* ============================= */
    /* DIFFICULTY */
    /* ============================= */

    if (session.step === "DIFFICULTY") {
      const picked = pickOption(text, OPTIONS.DIFFICULTY);
      if (!picked) {
        await showOptions(from, "⚡ Difficulty", OPTIONS.DIFFICULTY);
        return;
      }

      session.data.difficulty = picked;
      session.step = "NUM";

      await redis.set(SESSION_KEY(from), JSON.stringify(session));
      await showOptions(from, "🔢 Number of Questions", OPTIONS.NUM);
      return;
    }

    /* ============================= */
    /* NUM */
    /* ============================= */

    if (session.step === "NUM") {
      const picked = pickOption(text, OPTIONS.NUM);
      const num = Number(picked || 5);

      await redis.del(SESSION_KEY(from));

      await sendWatiSessionMessage(
        from,
        `🎯 MCQ will start now\n\nLevel: ${session.data.level}\nSubject: ${session.data.subject}\nChapter: ${session.data.chapter}\nDifficulty: ${session.data.difficulty}\nQuestions: ${num}`
      );
    }
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e);
  }
};

/* ========================================================= */
/* HEALTH */
/* ========================================================= */

exports.healthCheck = (req, res) => {
  res.json({ status: "OK", time: new Date().toISOString() });
};
