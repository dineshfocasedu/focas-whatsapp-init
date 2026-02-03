exports.normalizePhone = raw =>
  String(raw || "").replace(/\D/g, "").replace(/^91/, "");
