const dotenv=require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./lib/db.js");

// Routes
const sessionRoutes = require("./routes/sessionRoutes");
const questionRoutes = require("./routes/questionRoutes");
const responseRoutes = require("./routes/responseRoutes");
const fileRoutes = require("./routes/fileRoutes");
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const profileRoutes = require("./routes/profileRoutes");
const adminRoutes = require("./routes/adminRoutes");
const paymentRoutes = require("./routes/payment");
const mcqRoutes = require("./routes/mcqRoutes");
const webhookRoutes = require("./routes/webhook.routes");

const app = express();

/* ---------------- MIDDLEWARE ---------------- */
app.use(express.json({ limit: "10mb" }));
app.use(cors());

/* ---------------- DB CONNECTION ---------------- */
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("Mongo connection failed:", err);
    return res.status(500).json({ error: "Database connection failed" });
  }
});

/* ---------------- HEALTH CHECK ---------------- */
app.get("/", (req, res) => {
  res.send("Mentor API is running 🚀");
});

app.get("/test", (req, res) => {
  res.json({ status: "ok" });
});

/* ---------------- ROUTES ---------------- */
app.use("/api/admin", adminRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/questions", questionRoutes);
app.use("/api/responses", responseRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/mcq", mcqRoutes);
app.use("/api/data", webhookRoutes);

/* ---------------- ERROR HANDLER ---------------- */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

/* ---------------- EXPORT (NO LISTEN) ---------------- */
module.exports = app;
