exports.pickOption = (input, options = []) => {
  if (!input) return null;
  const val = String(input).trim().toLowerCase();

  if (/^\d+$/.test(val)) {
    return options[Number(val) - 1] || null;
  }

  return options.find(o => o.toLowerCase() === val) || null;
};
