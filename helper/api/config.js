const { asFunction } = require("../handler.cjs");

module.exports = asFunction(helper => helper.config(), "GET");
