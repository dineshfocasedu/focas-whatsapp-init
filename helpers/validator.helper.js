exports.isValidEmail = email =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
