const axios = require("axios");

async function sendTextMessage(to, messageText) {
  const payload = {
    to,
    content_type: "text",
    text: messageText
  };

  try {
    const response = await axios.post(
      "https://api.convonite.com/v1/script_messages",
      payload,
      {
        headers: {
          "x-api-key": "fffa82cf-d06a-4bd4-82c7-572ef508b89e-795238bc088ddc9fb076b3dadce65326",
          "x-channel-id": "24966000000395327",
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Message sent:", response.data);
    return response.data;
  } catch (error) {
    console.error(
      "❌ Error sending message:",
      error.response?.data || error.message
    );
    throw error;
  }
}
module.exports = sendTextMessage;
