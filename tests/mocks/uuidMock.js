// uuid v14+ ships ESM-only, which Jest's CJS runtime cannot parse.
// crypto.randomUUID produces real v4 UUIDs, keeping behavior equivalent.
const crypto = require('node:crypto');

module.exports = { v4: () => crypto.randomUUID() };
