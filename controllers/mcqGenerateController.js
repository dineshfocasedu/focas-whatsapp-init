const limitService = require("../services/limitService");
const mcqService = require("../services/mcqService");
const { validateMCQGenerate } = require("../utils/validators");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const PREMIUM_CHAPTERS = require("../config/premiumChapters");
const crypto = require("crypto");
const { sendSelectionRequest } = require("../services/convonite.service.js");


/**
 * 🔥 SINGLE SOURCE OF TRUTH
 */

/**
 * 🔥 CORE FUNCTION (USED BY API + WHATSAPP)
 */
async function generateMCQCore(payload) {
  const {
    userId,
    level,
    subject,
    chapter_name,
    unit_name = "",
    difficulty,
    numQuestions
  } = payload;


  // ✅ VALIDATION
  const validation = validateMCQGenerate({
    level,
    subject,
    chapter: chapter_name,
    difficulty,
    numQuestions
  });

  if (!validation.valid) {
    const err = new Error(validation.error);
    err.status = 400;
    throw err;
  }

  // ✅ USER
  const user = await User.findOne({ userId });
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  // ✅ SUBSCRIPTION
  const subscription = await Subscription.findOne({
    userId,
    status: "active",
    endDate: { $gt: new Date() }
  }).sort({ createdAt: -1 });

  // ✅ PREMIUM CHECK
  const premiumChapters = PREMIUM_CHAPTERS[subject] || [];
  if (
    premiumChapters.includes(chapter_name) &&
    (!subscription || subscription.plan !== "pro")
  ) {
    const err = new Error("Premium subscription required");
    err.status = 403;
    throw err;
  }

  // ✅ LIMIT CHECK
  const limitCheck = await limitService.checkGenerationLimit(
    userId,
    subscription?.plan ?? "free",
    numQuestions
  );

  // ✅ PYTHON API
  const pythonResponse = await mcqService.generateMCQsFromPython(
    level,
    subject,
    chapter_name,
    unit_name,
    difficulty,
    limitCheck.toGenerate
  );

  if (!pythonResponse.success) {
    throw new Error(pythonResponse.error);
  }

  // ✅ SAVE
  const mcqIds = pythonResponse.mcqs.map(() => crypto.randomUUID());

  await mcqService.saveMCQGeneration(
    userId,
    { level, subject, chapter: chapter_name, unit: unit_name, difficulty },
    mcqIds,
    pythonResponse.mcqs
  );

  await limitService.incrementGenerated(userId, limitCheck.toGenerate);

  return {
    success: true,
    count: limitCheck.toGenerate,
    mcqs: pythonResponse.mcqs.map((m, i) => ({
      mcqId: mcqIds[i],
      question: m.question,
      options: m.options,
      difficulty
    }))
  };
}

/**
 * ✅ API CONTROLLER (MOBILE APP)
 */
async function generateMCQ(req, res) {
  try {
    const result = await generateMCQCore({
      userId: req.user.userId,
      level: req.body.level,
      subject: req.body.subject,
      chapter_name: req.body.chapter_name || req.body.chapter,
      unit_name: req.body.unit_name || "",
      difficulty: req.body.difficulty, // RAW
      numQuestions: req.body.numQuestions
    });
    console.log("Generated MCQs:", result);
    res.json(result);
    
    console.log(result)
   // sendSelectionRequest()

  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      error: err.message
    });
  }
}

module.exports = {
  generateMCQ,
  generateMCQCore
};
