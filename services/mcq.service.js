const axios = require("axios");

exports.getSubjects = level =>
  axios.get("http://31.97.228.184:5555/api/data/subjects", { params: { level } })
    .then(r => r.data || []);

exports.getChapters = (level, subject) =>
  axios.get("http://31.97.228.184:5555/api/data/chapters", { params: { level, subject } })
    .then(r => r.data || []);

exports.getUnits = chapter =>
  axios.get("http://31.97.228.184:5555/api/data/units", {
    params: { chapter_name: chapter }
  }).then(r => (r.data || []).map(u => u.unit_name).filter(Boolean));

