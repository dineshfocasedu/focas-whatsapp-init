
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const User = require("../models/User")


const {
  generateMCQsFromPython,
  saveMCQGeneration,
  submitMCQAnswer,
} = require("../services/mcqService");

/* ========================================================= */
/* MOCKS (REMOVE IN PROD)                                     */
/* ========================================================= */

const __mem = {};
const redis = {
  get: async (k) => __mem[k] ?? null,
  set: async (k, v, opt) => {
    __mem[k] = v;
    // ignore TTL in mock
  },
  del: async (k) => {
    delete __mem[k];
  },
};

/* ========================================================= */
/* CONSTANTS + KEYS                                           */
/* ========================================================= */

const MAX_TEXT_LENGTH = 1000;
const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const SESSION_KEY = (from) => `session:whatsapp:${from}`; // selection flow
const SIGNUP_KEY = (from) => `signup:whatsapp:${from}`; // email->name
const MCQ_KEY = (from) => `mcq:whatsapp:${from}`; // active quiz run
const DEDUPE_KEY = (id) => `dedupe:msg:${id}`; // message id dedupe
const DEDUPE_FALLBACK_KEY = (from, text, t) => `dedupe:fallback:${from}:${text}:${t}`; // fallback dedupe
const PROMPT_LOCK_KEY = (from) => `promptlock:${from}`; // prevents re-sending same step prompt

const DEDUPE_TTL_SEC = 60 * 10; // 10 minutes
const PROMPT_LOCK_TTL_SEC = 20; // seconds (enough for immediate replays)

/* ========================================================= */
/* ENV + BASE URLS                                            */
/* ========================================================= */

const DATA_API_BASE_URL = process.env.DATA_API_BASE_URL || "http://31.97.228.184:5555";

/* ========================================================= */
/* WATI SEND MESSAGE                                          */
/* ========================================================= */

async function sendWatiSessionMessage(phoneNumber, messageText) {
  const { WATI_API_TOKEN, WATI_TENANT_ID, WATI_BASE_URL } = process.env;

  if (!WATI_API_TOKEN || !WATI_TENANT_ID || !WATI_BASE_URL) {
    console.error("[WATI] ❌ Missing WATI env vars");
    return null;
  }

  try {
    const url = `${WATI_BASE_URL}/${WATI_TENANT_ID}/api/v1/sendSessionMessage/${encodeURIComponent(
      phoneNumber
    )}`;

    const response = await axios.post(url, null, {
      params: { messageText },
      headers: {
        Accept: "*/*",
        Authorization: `Bearer ${WATI_API_TOKEN}`,
      },
      timeout: 15000,
    });

    console.log("[WATI] ✅ Sent:", phoneNumber, response.status);
    return response.data;
  } catch (e) {
    console.error("[WATI] ❌ Send failed:", e.response?.status, e.response?.data || e.message);
    return null;
  }
}

/* ========================================================= */
/* DATA API (GET)                                             */
/* ========================================================= */

async function getSubjects(level) {
  try {
    const r = await axios.get(`${DATA_API_BASE_URL}/api/data/subjects`, {
      params: { level },
      timeout: 20000,
    });
    return r.data || [];
  } catch (e) {
    console.error("[DATA API] subjects error:", e.message);
    return [];
  }
}

async function getChapters(level, subject) {
  try {
    const r = await axios.get(`${DATA_API_BASE_URL}/api/data/chapters`, {
      params: { level, subject },
      timeout: 20000,
    });
    return r.data || [];
  } catch (e) {
    console.error("[DATA API] chapters error:", e.message);
    return [];
  }
}

async function getUnits(chapter) {
  try {
    const r = await axios.get(`${DATA_API_BASE_URL}/api/data/units`, {
      params: { chapter_name: chapter },
      timeout: 20000,
    });
    const arr = r.data || [];
    return arr.map((u) => u.unit_name).filter(Boolean);
  } catch (e) {
    console.error("[DATA API] units error:", e.message);
    return [];
  }
}



function digitsOnly(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

function normalizeIncomingFrom(body) {
  return String(body?.from || body?.waId || "").trim();
}

function getIncomingText(body) {
  const raw = body?.text ?? body?.message ?? "";
  return String(raw || "").trim().slice(0, MAX_TEXT_LENGTH);
}

function isValidEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text || "").trim());
}

function pickOption(input, options) {
  const n = String(input || "").trim().toLowerCase();

  // number selection: "1", "2", ...
  if (/^\d+$/.test(n)) {
    const idx = Number(n) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }

  // text selection: match option text
  return options.find((o) => String(o).trim().toLowerCase() === n) || null;
}

async function getJson(key) {
  const v = await redis.get(key);
  return v ? JSON.parse(v) : null;
}
async function setJson(key, val, ttlSec) {
  if (ttlSec) {
    await redis.set(key, JSON.stringify(val), { EX: ttlSec });
  } else {
    await redis.set(key, JSON.stringify(val));
  }
}
async function delKey(key) {
  await redis.del(key);
}

function isUserInboundMessage(body) {
  if (!body || typeof body !== "object") return false;

  // Common WATI flags (varies by payload)
  if (body.isOwner === true) return false;
  if (body.isGroup === true) return false;

  // If message object exists
  if (body.message && body.message.isOwner === true) return false;

  // Many WATI payloads include eventType/statusType
  if (body.eventType && body.eventType !== "message") return false;
  if (body.statusType && body.statusType !== "message") return false;

  // If it's clearly a status update, ignore
  const t = String(body.type || body.messageType || "").toLowerCase();
  if (t && t !== "text" && t !== "message") {
    // If you want to allow other inbound types, expand here.
  }

  // Must have from + text-ish content
  const from = normalizeIncomingFrom(body);
  const txt = getIncomingText(body);
  if (!from || !txt) return false;

  return true;
} 

async function dedupeOrSkip(from, text, messageId) {
  if (messageId) {
    const k = DEDUPE_KEY(messageId);
    const seen = await redis.get(k);
    if (seen) return true;
    await redis.set(k, "1", { EX: DEDUPE_TTL_SEC });
    return false;
  }

  // fallback: dedupe by time bucket (10s)
  const bucket = Math.floor(Date.now() / 10000);
  const k2 = DEDUPE_FALLBACK_KEY(from, text.toLowerCase(), bucket);
  const seen2 = await redis.get(k2);
  if (seen2) return true;
  await redis.set(k2, "1", { EX: DEDUPE_TTL_SEC });
  return false;
}


async function canSendStepPrompt(from, step) {
  const lock = await getJson(PROMPT_LOCK_KEY(from));
  if (lock?.step === step) return false;
  await setJson(PROMPT_LOCK_KEY(from), { step, at: Date.now() }, PROMPT_LOCK_TTL_SEC);
  return true;
}

/* ========================================================= */
/* MCQ RUN HELPERS                                            */
/* ========================================================= */

function formatMCQQuestion(mcq, index, total) {
  const body = (mcq.options || [])
    .map((opt, i) => `${OPTION_LETTERS[i]}. ${opt}`)
    .join("\n");
  return `*Q${index + 1}/${total}*\n${mcq.question}\n\n${body}\n\nReply with A/B/C/D or 1/2/3/4\nType *STOP* to exit.`;
}

function parseAnswer(rawText, options = []) {
  const val = String(rawText || "").trim();
  if (!val) return null;

  const upper = val.toUpperCase();

  // A/B/C
  if (/^[A-Z]$/.test(upper)) {
    const idx = OPTION_LETTERS.indexOf(upper);
    if (idx >= 0 && idx < options.length) return OPTION_LETTERS[idx];
  }

  // 1/2/3
  if (/^\d+$/.test(val)) {
    const n = Number(val);
    if (n >= 1 && n <= options.length) return OPTION_LETTERS[n - 1];
  }

  return null;
}

async function getMCQRun(from) {
  return getJson(MCQ_KEY(from));
}
async function setMCQRun(from, run) {
  await setJson(MCQ_KEY(from), run);
}
async function clearMCQRun(from) {
  await delKey(MCQ_KEY(from));
}

async function sendNextMCQ(from, run) {
  const current = run.mcqs[run.index];
  if (!current) return false;
  await sendWatiSessionMessage(from, formatMCQQuestion(current, run.index, run.total));
  return true;
}

/* ========================================================= */
/* OPTIONS DISPLAY                                             */
/* ========================================================= */

async function showOptions(from, label, options) {
  const lines = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const message = `*${label}*\n\n${lines}\n\nReply with option number or text.`;
  return sendWatiSessionMessage(from, message);
}

/* ========================================================= */
/* MAIN WEBHOOK HANDLER                                        */
/* ========================================================= */

exports.webhookHandler = async (req, res) => {

  // ACK immediately (WATI expects this)
  res.sendStatus(200);

  try {
     if (!isUserInboundMessage(req.body)) {
      console.log("[WEBHOOK] Ignored non-user event");
      return;
    } 

    const body = req.body;

    console.log(body)

    const from = normalizeIncomingFrom(body);
    const rawText = getIncomingText(body);
    const text = rawText.toLowerCase();
    const messageId = body.id || body.whatsappMessageId || body.messageId;

    // DEDUPE
    const shouldSkip = await dedupeOrSkip(from, rawText, messageId);
    if (shouldSkip) {
      console.log("[WEBHOOK] Duplicate detected. Skipping.");
      return;
    }

    console.log("\n[WEBHOOK] From:", from);
    console.log("[WEBHOOK] Text:", rawText);

    const phoneDigits = digitsOnly(from);

    // load state
    let session = await getJson(SESSION_KEY(from));
    let signup = await getJson(SIGNUP_KEY(from));
    console.log(phoneDigits.slice(-10) + "Digit")
    const phonee=phoneDigits.slice(-10)
    let user = await User.findOne({ phoneNumber: phonee });
    // console.log('User'  + user)
    



    /* ===================================================== */
    /* ACTIVE MCQ ANSWER FLOW                                 */
    /* ===================================================== */

    const mcqRun = await getMCQRun(from);
    if (mcqRun) {
      if (text === "stop" || text === "cancel") {
        await clearMCQRun(from);
        await sendWatiSessionMessage(from, "🛑 MCQ canceled. Type *MCQ* to restart.");
        return;
      }

      const current = mcqRun.mcqs[mcqRun.index];
      if (!current) {
        await clearMCQRun(from);
        await sendWatiSessionMessage(from, "❌ No question found. Type *MCQ* to restart.");
        return;
      }

      const userAnswer = parseAnswer(rawText, current.options || []);
      if (!userAnswer) {
        await sendWatiSessionMessage(from, "❌ Please reply with A/B/C/D or 1/2/3/4.");
        return;
      }

      // ✅ Your DB evaluation + progress + explanation
      const result = await submitMCQAnswer(
        mcqRun.userId,
        current.mcqId,
        userAnswer,
        { timeSpent: 0 }
      );

      const isCorrect = result.evaluation.isCorrect;
      const correctAnswer = result.evaluation.correctAnswer;

      if (isCorrect) mcqRun.correct = (mcqRun.correct || 0) + 1;
      mcqRun.index += 1;

      const feedback =
        `${isCorrect ? "✅ *Correct!*" : "❌ *Incorrect.*"}\n` +
        `Correct answer: *${correctAnswer}*\n` +
        (result.explanation ? `\n📖 ${result.explanation}` : "");

      await sendWatiSessionMessage(from, feedback);

      if (mcqRun.index >= mcqRun.total) {
        await clearMCQRun(from);
        const percentage = ((mcqRun.correct / mcqRun.total) * 100).toFixed(0);
        await sendWatiSessionMessage(
          from,
          `🎉 *Quiz Complete!*\n📊 Score: ${mcqRun.correct}/${mcqRun.total}\n🏆 ${percentage}%\n\nType *MCQ* to start again.`
        );
        return;
      }

      await setMCQRun(from, mcqRun);
      await sendNextMCQ(from, mcqRun);
      return;
    }

    /* ===================================================== */
    /* SIGNUP FLOW                                             */
    /* ===================================================== */

    if (!user && !signup && isValidEmail(rawText)) {
      await setJson(SIGNUP_KEY(from), { step: "NAME", email: rawText }, 900);
      await sendWatiSessionMessage(from, "✅ *Email received.* Now please send your *Name*.");
      return;
    }

    if (!user && signup?.step === "NAME") {
      const name = rawText.trim();
      if (!name || name.length < 2) {
        await sendWatiSessionMessage(from, "❌ Please send a valid name (min 2 chars).");
        return;
      }

      user = await User.create({
        userId: uuidv4(),
        name,
        email: signup.email,
        phoneNumber: phoneDigits.slice(-10),
      });

      await delKey(SIGNUP_KEY(from));
      await sendWatiSessionMessage(from, `🎉 *Welcome, ${name}!* \n\nType *MCQ* to start.`);
      return;
    }

    /* ===================================================== */
    /* MCQ START COMMAND                                       */
    /* ===================================================== */

    if (text === "mcq" || text === "/mcq") {
      if (!user) {
        await sendWatiSessionMessage(from, "👋 Welcome! Please send your *email* to signup.");
        return;
      }

      // Start selection flow
      session = { step: "LEVEL", data: { userId: user.userId } };
      await setJson(SESSION_KEY(from), session, 3600);

      // Prompt lock prevents repeated "Select level" if WATI retries quickly
      if (await canSendStepPrompt(from, "LEVEL")) {
        await showOptions(from, "📘 Select Your Level", ["Foundation", "Intermediate", "Final"]);
      }
      return;
    }

    // No session active
    if (!session) {
      if (user) {
        await sendWatiSessionMessage(from, `👋 Hi ${user.name}!\n\nType *MCQ* to start.`);
      }
      return;
    }

    /* ===================================================== */
    /* SESSION FLOW: LEVEL                                     */
    /* ===================================================== */

    if (session.step === "LEVEL") {
      const levels = ["Foundation", "Intermediate", "Final"];
      const picked = pickOption(rawText, levels);

      if (!picked) {
        if (await canSendStepPrompt(from, "LEVEL")) {
          await showOptions(from, "📘 Select Your Level", levels);
        }
        return;
      }

      session.data.level = picked;
      session.step = "SUBJECT";

      // ✅ fetch subjects based on selected level
      const subjects = await getSubjects(picked);
      if (!subjects || subjects.length === 0) {
        session.step = "LEVEL";
        await setJson(SESSION_KEY(from), session, 3600);
        await sendWatiSessionMessage(from, "❌ No subjects found for this level. Try again.");
        if (await canSendStepPrompt(from, "LEVEL")) {
          await showOptions(from, "📘 Select Your Level", levels);
        }
        return;
      }

      session.data.availableSubjects = subjects;
      await setJson(SESSION_KEY(from), session, 3600);

      if (await canSendStepPrompt(from, "SUBJECT")) {
        await showOptions(from, "📚 Select Subject", subjects);
      }
      return;
    }

    /* ===================================================== */
    /* SESSION FLOW: SUBJECT                                   */
    /* ===================================================== */

    if (session.step === "SUBJECT") {
      const picked = pickOption(rawText, session.data.availableSubjects || []);
      if (!picked) {
        if (await canSendStepPrompt(from, "SUBJECT")) {
          await showOptions(from, "📚 Select Subject", session.data.availableSubjects || []);
        }
        return;
      }

      session.data.subject = picked;
      session.step = "CHAPTER";

      const chapters = await getChapters(session.data.level, picked);
      if (!chapters || chapters.length === 0) {
        session.step = "SUBJECT";
        await setJson(SESSION_KEY(from), session, 3600);
        await sendWatiSessionMessage(from, "❌ No chapters found. Pick another subject.");
        if (await canSendStepPrompt(from, "SUBJECT")) {
          await showOptions(from, "📚 Select Subject", session.data.availableSubjects || []);
        }
        return;
      }

      session.data.availableChapters = chapters;
      await setJson(SESSION_KEY(from), session, 3600);

      if (await canSendStepPrompt(from, "CHAPTER")) {
        await showOptions(from, "📖 Select Chapter", chapters);
      }
      return;
    }

    /* ===================================================== */
    /* SESSION FLOW: CHAPTER                                   */
    /* ===================================================== */

    if (session.step === "CHAPTER") {
      const picked = pickOption(rawText, session.data.availableChapters || []);
      if (!picked) {
        if (await canSendStepPrompt(from, "CHAPTER")) {
          await showOptions(from, "📖 Select Chapter", session.data.availableChapters || []);
        }
        return;
      }

      session.data.chapter = picked;
      session.step = "UNIT";

      const units = await getUnits(picked);
      session.data.availableUnits = units || [];
      await setJson(SESSION_KEY(from), session, 3600);

      if (!units || units.length === 0) {
        // auto skip to difficulty
        session.data.unit = "";
        session.step = "DIFFICULTY";
        await setJson(SESSION_KEY(from), session, 3600);
        if (await canSendStepPrompt(from, "DIFFICULTY")) {
          await showOptions(from, "⚡ Select Difficulty", ["easy", "medium", "hard"]);
        }
        return;
      }

      if (await canSendStepPrompt(from, "UNIT")) {
        await showOptions(from, "📂 Select Unit (or reply 'Skip')", [...units, "Skip"]);
      }
      return;
    }

    /* ===================================================== */
    /* SESSION FLOW: UNIT                                      */
    /* ===================================================== */

    if (session.step === "UNIT") {
      if (text === "skip") {
        session.data.unit = "";
      } else {
        const picked = pickOption(rawText, session.data.availableUnits || []);
        if (!picked) {
          if (await canSendStepPrompt(from, "UNIT")) {
            await showOptions(from, "📂 Select Unit (or reply 'Skip')", [
              ...(session.data.availableUnits || []),
              "Skip",
            ]);
          }
          return;
        }
        session.data.unit = picked;
      }

      session.step = "DIFFICULTY";
      await setJson(SESSION_KEY(from), session, 3600);

      if (await canSendStepPrompt(from, "DIFFICULTY")) {
        await showOptions(from, "⚡ Select Difficulty", ["easy", "medium", "hard"]);
      }
      return;
    }

    /* ===================================================== */
    /* SESSION FLOW: DIFFICULTY                                */
    /* ===================================================== */

    if (session.step === "DIFFICULTY") {
      const picked = pickOption(rawText, ["easy", "medium", "hard"]);
      if (!picked) {
        if (await canSendStepPrompt(from, "DIFFICULTY")) {
          await showOptions(from, "⚡ Select Difficulty", ["easy", "medium", "hard"]);
        }
        return;
      }

      session.data.difficulty = picked;
      session.step = "NUM";
      await setJson(SESSION_KEY(from), session, 3600);

      if (await canSendStepPrompt(from, "NUM")) {
        await showOptions(from, "🔢 Number of Questions", ["1", "5", "10"]);
      }
      return;
    }

    /* ===================================================== */
    /* SESSION FLOW: NUM -> GENERATE MCQ + START RUN           */
    /* ===================================================== */

    if (session.step === "NUM") {
      const picked = pickOption(rawText, ["1", "5", "10"]);
      const numQuestions = Math.max(1, Number(picked || rawText) || 1);

      const required = ["level", "subject", "chapter", "difficulty"];
      const missing = required.filter((f) => !session.data[f]);
      if (missing.length > 0) {
        await delKey(SESSION_KEY(from));
        await sendWatiSessionMessage(from, "❌ Session incomplete. Type *MCQ* to restart.");
        return;
      }



      // Summary message
      await sendWatiSessionMessage(
        from,
        `✅ Generating MCQ...\n` +
          `📘 Level: ${session.data.level}\n` +
          `📚 Subject: ${session.data.subject}\n` +
          `📖 Chapter: ${session.data.chapter}\n` +
          `📂 Unit: ${session.data.unit || "N/A"}\n` +
          `⚡ Difficulty: ${session.data.difficulty}\n` +
          `🔢 Questions: ${numQuestions}\n\nPlease wait...`
      );



            const payload = {
              userId: user.userId,
              level: session.data.level,
              subject: session.data.subject,
              chapter: session.data.chapter,
              unit: session.data.unit,
              difficulty: session.data.difficulty,
              numQuestions: Number(numQuestions)
            };
      
           
            const mcq = await generateMCQsFromPython(payload);

      
      
     
      // pythonMcqs expected: array of objects with question/options/correct_answer/explanation etc.
      if (!mcq || !Array.isArray(mcq) || mcq.length === 0) {
        await delKey(SESSION_KEY(from));
        await sendWatiSessionMessage(from, "❌ Could not generate questions. Type *MCQ* to try again.");
        return;
      }

      // ✅ create mcqIds and save in DB with answers
      const mcqIds = mcq.map(() => uuidv4());

      await saveMCQGeneration(
        session.data.userId,
        {
          level: session.data.level,
          subject: session.data.subject,
          chapter: session.data.chapter,
          unit: session.data.unit || "",
          difficulty: session.data.difficulty,
        },
        mcqIds,
        mcq
      );

      // Build run payload for WhatsApp (only what you need for asking)
      const mcqs = mcq.map((mcq, idx) => ({
        mcqId: mcqIds[idx],
        question: mcq.question,
        options: mcq.options,
      }));

      const run = {
        userId: session.data.userId,
        mcqs,
        index: 0,
        correct: 0,
        total: mcqs.length,
      };

      await setMCQRun(from, run);
      await delKey(SESSION_KEY(from)); // clear selection flow

      await sendWatiSessionMessage(
        from,
        `🎯 *Quiz Started!*\n📊 ${mcqs.length} Questions\n\nType *STOP* to exit.\n\nLet's go! 🚀`
      );

      await sendNextMCQ(from, run);
      return;
    }
  } catch (error) {
    console.error("[WEBHOOK] Error:", error);
  }
};

/* ========================================================= */
/* HEALTH CHECK                                               */
/* ========================================================= */

exports.healthCheck = (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "WATI MCQ Bot is running",
    timestamp: new Date().toISOString(),
  });
};
