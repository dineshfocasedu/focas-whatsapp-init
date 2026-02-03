const axios = require("axios");
const https = require("https");

/**
 * 🔥 HARD FIX:
 * - Force IPv4
 * - Force TLS 1.2
 * - Avoid Node 18+ TLS 1.3 rejection
 */
const httpsAgent = new https.Agent({
  keepAlive: true,
  family: 4,                // IPv4 only
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
});

const convoniteAxios = axios.create({
  baseURL: "https://api.convonite.com",
  timeout: 20000,
  httpsAgent,
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.CONVONITE_API_KEY,
    "x-channel-id": process.env.CONVONITE_CHANNEL_ID,
  },
});

/**
 * ✅ Plain text sender
 */
async function sendTextMessage(to, text) {
  try {
    const payload = {
      to,
      content_type: "text",
      text,
    };

    const res = await convoniteAxios.post(
      "/v1/script_messages",
      payload
    );

    console.log("✅ Convonite response:", res.data);
    return res.data;
  } catch (err) {
    console.error("❌ Convonite sendTextMessage failed");

    if (err.response) {
      console.error("STATUS:", err.response.status);
      console.error("DATA:", err.response.data);
    } else if (err.request) {
      console.error("NO RESPONSE FROM CONVONITE");
    } else {
      console.error("ERROR:", err.message);
    }

    throw err;
  }
}

/**
 * ✅ Selection helper (text fallback only)
 */
async function sendSelectionRequest(to, message, options = []) {
  if (!options.length) {
    // 🔥 IMPORTANT: avoid your previous crash
    return sendTextMessage(to, message);
  }

  const body =
    message +
    "\n\n" +
    options.map((o, i) => `${i + 1}. ${o.text || o}`).join("\n");

  return sendTextMessage(to, body);
}

async function createConvoniteContact(name,mobile){
   try {
    const payload = {
      name,
      mobile
    };


    const res = await convoniteAxios.post(
      "/v1/contacts",
      payload
    );

    console.log("✅ Convonite response:", res.data);
    return res.data;
  } catch (err) {
    console.error("❌ Convonite sendTextMessage failed");

    if (err.response) {
      console.error("STATUS:", err.response.status);
      console.error("DATA:", err.response.data);
    } else if (err.request) {
      console.error("NO RESPONSE FROM CONVONITE");
    } else {
      console.error("ERROR:", err.message);
    }

    throw err;
  }
}

module.exports = {
  sendTextMessage,
  sendSelectionRequest,
  createConvoniteContact
};
