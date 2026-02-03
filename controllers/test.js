const { v4: uuidv4 } = require("uuid");
const User = require("../models/User");
const redis = require("../config/redis");
const Subscription = require("../models/Subscription");
const limitService = require("../services/limitService");
const mcqService = require("../services/mcqService");

const { pickOption } = require("../helpers/option.helper");
const { normalizePhone } = require("../helpers/normalize.helper");
const { isValidEmail } = require("../helpers/validator.helper");

const {
  getSession,
  setSession,
  clearSession
} = require("../services/session.service");

const {
  getSubjects,
  getChapters,
  getUnits
} = require("../services/mcq.service");

const {
  sendTextMessage,
  sendSelectionRequest,
  createConvoniteContact
} = require("../services/convonite.service");

const { generateMCQCore } = require("./mcqGenerateController");

const MCQ_SESSION_TTL = 3600; // seconds
const MCQ_KEY = from => `mcq:whatsapp:${from}`;
const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_TEXT_LENGTH = 1000;

/* -------------------------------------------------- */
/* HELPERS */
/* -------------------------------------------------- */

async function ensureConvoniteContact(from, user, phone) {
  const key = `convonite:contact:${from}`;
  if (await redis.get(key)) return;

  const name = user?.name || `User ${phone.slice(-4)}`;
  await createConvoniteContact(name, from);
  await redis.set(key, "1", { EX: 86400 * 30 });
}

function showOptions(from, label, options) {
  return sendSelectionRequest(from, label, options);
}

async function getMCQRun(from) {
  const data = await redis.get(MCQ_KEY(from));
  return data ? JSON.parse(data) : null;
}

async function setMCQRun(from, payload) {
  await redis.set(MCQ_KEY(from), JSON.stringify(payload), { EX: MCQ_SESSION_TTL });
}

async function clearMCQRun(from) {
  await redis.del(MCQ_KEY(from));
}

function normalizeOptions(options) {
  return (Array.isArray(options) ? options : [])
    .map(o => (typeof o === "string" ? o.trim() : ""))
    .filter(Boolean);
}

function validateMCQRunState(mcqRun) {
  if (!mcqRun || typeof mcqRun !== "object") return false;
  if (!mcqRun.userId || typeof mcqRun.userId !== "string") return false;
  if (!Array.isArray(mcqRun.mcqs) || !mcqRun.mcqs.length) return false;
  if (!Number.isInteger(mcqRun.index) || mcqRun.index < 0) return false;
  if (!Number.isInteger(mcqRun.total) || mcqRun.total < 1) return false;
  if (mcqRun.index > mcqRun.mcqs.length) return false;
  if (
    !mcqRun.mcqs.every(
      q => q?.mcqId && q.question && Array.isArray(q.options) && q.options.length
    )
  ) {
    return false;
  }
  return true;
}

function formatMCQQuestion(mcq, index, total) {
  const options = mcq.options || [];
  const body = options
    .slice(0, OPTION_LETTERS.length)
    .map((opt, i) => `${OPTION_LETTERS[i]}. ${opt}`)
    .join("\n");

  return (
    `*Q${index + 1}/${total}*\n${mcq.question}\n\n` +
    `${body}\n\n` +
    `Reply with the option letter (e.g., A) or number.`
  );
}

async function sendNextMCQ(from, mcqRun) {
  const current = mcqRun.mcqs[mcqRun.index];
  if (!current) return false;

  await sendTextMessage(from, formatMCQQuestion(current, mcqRun.index, mcqRun.total));
  return true;
}

function parseAnswer(rawText, options = []) {
  if (!rawText) return null;
  const val = rawText.trim();
  const upper = val.toUpperCase();

  // Letter (A, B, C...)
  if (/^[A-Z]$/.test(upper)) {
    const idx = OPTION_LETTERS.indexOf(upper);
    if (idx >= 0 && idx < options.length) return OPTION_LETTERS[idx];
  }

  // Number (1,2,3...)
  if (/^\d+$/.test(val)) {
    const num = Number(val);
    if (num >= 1 && num <= options.length) {
      return OPTION_LETTERS[num - 1];
    }
  }

  // Exact option text match
  const matchIndex = options.findIndex(
    o => o.toLowerCase().trim() === val.toLowerCase().trim()
  );
  if (matchIndex >= 0) return OPTION_LETTERS[matchIndex];

  return null;
}

function validateWebhookPayload(body) {
  if (!body || typeof body !== "object") return { ok: false };

  const from = typeof body.from === "string" ? body.from.trim() : "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!from || !messages.length) {
    if (body.terminated) return { ok: false, terminated: true };
    return { ok: false };
  }

  if (body.terminated && !messages.length) return { ok: false, terminated: true };

  const msg = messages.at(-1);
  if (!msg || typeof msg !== "object") return { ok: false };

  const contentType = msg.content_type || msg.type;
  const raw =
    contentType === "text"
      ? msg.message || msg.text
      : msg.selection?.text || msg.selection?.id;

  if (typeof raw !== "string" || !raw.trim()) return { ok: false };

  const trimmed = raw.slice(0, MAX_TEXT_LENGTH);
  return {
    ok: true,
    from,
    msg,
    rawText: trimmed,
    lowerText: trimmed.trim().toLowerCase()
  };
}

/* -------------------------------------------------- */
/* CONTROLLER */
/* -------------------------------------------------- */

exports.handleWebhook = async (req, res) => {
  console.log(req.body)

  // console.log("Webhook received:", JSON.stringify(req.body).slice(0, 200) + "...");
  try {
    const inbound = validateWebhookPayload(req.body);
    if (inbound.terminated) {
      console.warn("Webhook marked terminated; acking without processing");
      return res.sendStatus(200);
    }
    if (!inbound.ok) {
      console.warn("Webhook validation failed");
      return res.sendStatus(200);
    }

    const { from, msg, rawText, lowerText: text } = inbound;

    /* DUPLICATE MESSAGE PROTECTION */
    if (msg.message_id) {
      const key = `msg:${msg.message_id}`;
      if (await redis.get(key)) return res.sendStatus(200);
      await redis.set(key, "1", { EX: 86400 });
    }

    const phone = normalizePhone(from);

    /* LOAD USER + SESSION */
    let session = await getSession(`whatsapp:${from}`);
    let signup = await redis
      .get(`signup:${from}`)
      .then(v => (v ? JSON.parse(v) : null));

    let user = await User.findOne({ phoneNumber: phone });

    /* -------------------------------------------------- */
    /* ACTIVE MCQ FLOW (answering) */
    /* -------------------------------------------------- */

    const mcqRun = await getMCQRun(from);
    if (mcqRun) {
      if (!validateMCQRunState(mcqRun)) {
        await clearMCQRun(from);
        await sendTextMessage(
          from,
          "Your MCQ session looked invalid or expired. Type *MCQ* to start again."
        );
        return res.sendStatus(200);
      }

      // Allow user to cancel
      if (text === "stop" || text === "cancel") {
        await clearMCQRun(from);
        await sendTextMessage(from, "MCQ session canceled. Type *MCQ* to start again.");
        return res.sendStatus(200);
      }

      const current = mcqRun.mcqs[mcqRun.index];
      if (!current) {
        await clearMCQRun(from);
        await sendTextMessage(from, "No active MCQ found. Type *MCQ* to start.");
        return res.sendStatus(200);
      }

      const userAnswer = parseAnswer(rawText, current.options || []);
      if (!userAnswer) {
        await sendTextMessage(
          from,
          "Please reply with a valid option letter (e.g., A) or number."
        );
        return res.sendStatus(200);
      }

      // Evaluate answer (chapter optional -> omit)
      const subscription = await Subscription.findOne({
        userId: mcqRun.userId,
        status: "active",
        endDate: { $gt: new Date() }
      }).sort({ createdAt: -1 });

      await limitService.checkEvaluationLimit(
        mcqRun.userId,
        subscription?.plan ?? "free"
      );

      const result = await mcqService.submitMCQAnswer(
        mcqRun.userId,
        current.mcqId,
        userAnswer,
        { timeSpent: 30 }
      );

      await limitService.incrementEvaluations(mcqRun.userId);

      const isCorrect = result.evaluation.isCorrect;
      const correctAnswer = result.evaluation.correctAnswer;

      if (isCorrect) mcqRun.correct = (mcqRun.correct || 0) + 1;

      // Advance
      mcqRun.index += 1;

      const feedback =
        (isCorrect ? "✅ Correct!" : "❌ Incorrect.") +
        `\nCorrect answer: ${correctAnswer}` +
        (result.explanation ? `\n\nExplanation:\n${result.explanation}` : "");

      await sendTextMessage(from, feedback);

      if (mcqRun.index >= mcqRun.total) {
        await clearMCQRun(from);
        await sendTextMessage(
          from,
          `🎉 MCQ test complete!\nScore: ${mcqRun.correct}/${mcqRun.total}\nType *MCQ* to start a new test.`
        );
        return res.sendStatus(200);
      }

      await setMCQRun(from, mcqRun);
      await sendNextMCQ(from, mcqRun);
      return res.sendStatus(200);
    }

    /* -------------------------------------------------- */
    /* SIGNUP FLOW */
    /* -------------------------------------------------- */

    // EMAIL
    if (!user && !signup && isValidEmail(text)) {
      await redis.set(
        `signup:${from}`,
        JSON.stringify({ step: "NAME", email: text }),
        { EX: 900 }
      );
      await sendTextMessage(from, "✅ Email received.\nPlease send your *Name*.");
      return res.sendStatus(200);
    }

    // NAME
    if (!user && signup?.step === "NAME") {
      const name = rawText.trim();
      if (!name) {
        await sendTextMessage(from, "❌ Name cannot be empty. Please send your name.");
        return res.sendStatus(200);
      }

      user = await User.create({
        userId: uuidv4(),
        name,
        email: signup.email,
        phoneNumber: phone,
        createdAt: new Date()
      });

      await redis.del(`signup:${from}`);
      await ensureConvoniteContact(from, user, phone);

      await sendTextMessage(
        from,
        `🎉 Signup completed, *${name}*!\n\nType *MCQ* to start.`
      );
      return res.sendStatus(200);
    }

    /* -------------------------------------------------- */
    /* START MCQ */
    /* -------------------------------------------------- */

    if (text === "get video review" && !session) {
      if (!user) {
        await sendTextMessage(from, "👋 Please signup first by sending your email.");
        return res.sendStatus(200);
      }

      await ensureConvoniteContact(from, user, phone);

      session = { step: "LEVEL", data: {} };
      await setSession(`whatsapp:${from}`, session);

      return showOptions(
        from,
        "📘 *Select Level*",
        ["Foundation", "Intermediate", "Final"]
      );
    }

    if (!session) return res.sendStatus(200);

    /* -------------------------------------------------- */
    /* LEVEL */
    /* -------------------------------------------------- */

    if (session.step === "LEVEL") {
      const levels = ["Foundation", "Intermediate", "Final"];
      const picked = pickOption(rawText, levels);

      if (!picked) {
        return showOptions(from, "📘 *Select Level*", levels);
      }

      session.data.level = picked;
      session.step = "SUBJECT";

      let subjects;
      try {
        subjects = normalizeOptions(await getSubjects(picked));
      } catch (err) {
        console.error("Failed to load subjects", err);
        await sendTextMessage(from, "Unable to load subjects right now. Please try again shortly.");
        return res.sendStatus(200);
      }

      if (!subjects.length) {
        await sendTextMessage(from, "No subjects found for that level. Please pick another level.");
        return showOptions(from, "📘 *Select Level*", levels);
      }

      session.data.availableSubjects = subjects;

      await setSession(`whatsapp:${from}`, session);

      return showOptions(from, "📚 *Select Subject*", subjects);
    }

    /* -------------------------------------------------- */
    /* SUBJECT */
    /* -------------------------------------------------- */

    if (session.step === "SUBJECT") {
      const picked = pickOption(rawText, session.data.availableSubjects);

      if (!picked) {
        return showOptions(
          from,
          "📚 *Select Subject*",
          session.data.availableSubjects
        );
      }

      session.data.subject = picked;
      session.step = "CHAPTER";

      let chapters;
      try {
        chapters = normalizeOptions(await getChapters(session.data.level, picked));
      } catch (err) {
        console.error("Failed to load chapters", err);
        await sendTextMessage(from, "Unable to load chapters right now. Please try again shortly.");
        return res.sendStatus(200);
      }

      if (!chapters.length) {
        await sendTextMessage(from, "No chapters found. Please pick another subject or restart with *MCQ*.");
        return showOptions(from, "📚 *Select Subject*", session.data.availableSubjects);
      }

      session.data.availableChapters = chapters;

      await setSession(`whatsapp:${from}`, session);

      return showOptions(from, "📖 *Select Chapter*", chapters);
    }

    /* -------------------------------------------------- */
    /* CHAPTER */
    /* -------------------------------------------------- */

    if (session.step === "CHAPTER") {
      const picked = pickOption(rawText, session.data.availableChapters);

      if (!picked) {
        return showOptions(
          from,
          "📖 *Select Chapter*",
          session.data.availableChapters
        );
      }

      session.data.chapter_name = picked;

      let units;
      try {
        units = normalizeOptions(await getUnits(picked));
      } catch (err) {
        console.error("Failed to load units", err);
        await sendTextMessage(from, "Unable to load units right now. Please try again shortly.");
        return res.sendStatus(200);
      }

      session.data.availableUnits = units;

      if (units.length) {
        session.step = "UNIT";
        await setSession(`whatsapp:${from}`, session);

        return showOptions(
          from,
          "📂 *Select Unit* (or Skip)",
          [...units, "Skip"]
        );
      }

      session.data.unit_name = "";
      session.step = "DIFFICULTY";
      await setSession(`whatsapp:${from}`, session);

      return showOptions(
        from,
        "⚡ *Select Difficulty*",
        ["easy", "medium", "hard"]
      );
    }

    /* -------------------------------------------------- */
    /* UNIT */
    /* -------------------------------------------------- */

    if (session.step === "UNIT") {
      if (text === "skip") {
        session.data.unit_name = "";
      } else {
        const picked = pickOption(rawText, session.data.availableUnits);
        if (!picked) {
          return showOptions(
            from,
            "📂 *Select Unit* (or Skip)",
            [...session.data.availableUnits, "Skip"]
          );
        }
        session.data.unit_name = picked;
      }

      session.step = "DIFFICULTY";
      await setSession(`whatsapp:${from}`, session);

      return showOptions(
        from,
        "⚡ *Select Difficulty*",
        ["easy", "medium", "hard"]
      );
    }

    /* -------------------------------------------------- */
    /* DIFFICULTY */
    /* -------------------------------------------------- */

    if (session.step === "DIFFICULTY") {
      const picked = pickOption(rawText, ["easy", "medium", "hard"]);

      if (!picked) {
        return showOptions(
          from,
          "⚡ *Select Difficulty*",
          ["easy", "medium", "hard"]
        );
      }

      session.data.difficulty = picked;
      session.step = "NUM";
      await setSession(`whatsapp:${from}`, session);

      return showOptions(
        from,
        "🔢 *Number of Questions*",
        ["1", "5", "10"]
      );
    }

    /* -------------------------------------------------- */
    /* FINAL */
    /* -------------------------------------------------- */

    if (session.step === "NUM") {
      const picked = pickOption(rawText, ["1", "5", "10"]) || "1";

      const missing = ["level", "subject", "chapter_name", "difficulty"].filter(
        f => !session.data?.[f]
      );
      if (missing.length) {
        await clearSession(`whatsapp:${from}`);
        await sendTextMessage(
          from,
          "Session data was incomplete. Please type *MCQ* to start again."
        );
        return res.sendStatus(200);
      }

      const payload = {
        userId: user.userId,
        level: session.data.level,
        subject: session.data.subject,
        chapter_name: session.data.chapter_name,
        unit_name: session.data.unit_name,
        difficulty: session.data.difficulty,
        numQuestions: Number(picked)
      };

      await clearSession(`whatsapp:${from}`);

      await sendTextMessage(
        from,
        `✅ *MCQs Generating please wait 15 -30 seconds \n\n` +
          `📘 Level: ${payload.level}\n` +
          `📚 Subject: ${payload.subject}\n` +
          `📖 Chapter: ${payload.chapter_name}\n` +
          `📂 Unit: ${payload.unit_name || "N/A"}\n` +
          `⚡ Difficulty: ${payload.difficulty}` +
          `\n🔢 Number of Questions: ${payload.numQuestions}\n\n`
      );

      const mcq = await generateMCQCore(payload);
      console.log("Generated MCQ:", mcq);

      const mcqRunPayload = {
        userId: user.userId,
        mcqs: mcq.mcqs,
        index: 0,
        correct: 0,
        total: mcq.mcqs.length
      };

      await setMCQRun(from, mcqRunPayload);
      await sendNextMCQ(from, mcqRunPayload);

      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(200);
  }
};
