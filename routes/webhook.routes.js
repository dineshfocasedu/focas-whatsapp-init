/**
 * WATI Webhook Routes
 */

const express = require("express");
const router = express.Router();

const { webhookHandler, healthCheck } = require("../controllers/watiWebhook");

/* ========================================================= */
/* WEBHOOK ENDPOINTS */
/* ========================================================= */

/**
 * POST /webhook
 * Main WATI webhook - receives messages from WhatsApp
 */
router.post("/webhook", webhookHandler);



/**
 * POST /wati/webhook
 * Alternative webhook path
 */
router.post("/wati/webhook", webhookHandler);

/* ========================================================= */
/* HEALTH CHECK */
/* ========================================================= */

/**
 * GET /health
 * Health check endpoint
 */
router.get("/health", healthCheck);

/**
 * GET /
 * Root endpoint
 */
router.get("/", (req, res) => {
  res.status(200).json({
    name: "WATI MCQ Bot",
    version: "1.0.0",
    status: "running",
    endpoints: {
      webhook: "POST /webhook",
      health: "GET /health",
    },
  });
});

/* ========================================================= */
/* ERROR HANDLER */
/* ========================================================= */

/**
 * 404 handler
 */
router.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.path} not found`,
  });
});

module.exports = router;