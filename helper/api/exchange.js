const { asFunction } = require("../handler.cjs");

module.exports = asFunction((helper, body) => helper.exchange(body), "POST");
