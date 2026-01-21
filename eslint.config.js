const nextConfig = require("eslint-config-next");

module.exports = Array.isArray(nextConfig) ? nextConfig : [nextConfig];
