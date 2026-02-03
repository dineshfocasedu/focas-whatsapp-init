const { v4: uuidv4 } = require("uuid");
const User = require("../models/User");

async function ensureUser({ phoneNumber }) {
  let user = await User.findOne({ phoneNumber });

  if (user) {
    user.lastLogin = new Date();
    await user.save();
    return user;
  }

  user = await User.create({
    userId: uuidv4(),
    phoneNumber,
    email: `${phoneNumber}@wati.user`,
    name: "WhatsApp User",
    lastLogin: new Date()
  });

  return user;
}

module.exports = ensureUser;
