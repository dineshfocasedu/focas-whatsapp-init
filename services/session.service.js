const redis = require("../config/redis");

exports.getSession = async key => {
  const data = await redis.get(key);
  return data ? JSON.parse(data) : null;
};

exports.setSession = async (key, value, ttl = 1800) => {
  await redis.set(key, JSON.stringify(value), { EX: ttl });
};

exports.clearSession = key => redis.del(key);
