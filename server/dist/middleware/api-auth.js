"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.optionalApiAuth = optionalApiAuth;
exports.requireApiAuth = requireApiAuth;
const auth_1 = require("../services/auth");
function attachApiKey(req) {
    const token = (0, auth_1.parseApiToken)(req);
    if (!token) {
        return null;
    }
    const apiKey = (0, auth_1.getApiKeyByToken)(token);
    if (!apiKey) {
        return null;
    }
    req.apiKey = apiKey;
    return apiKey;
}
function optionalApiAuth(req, _res, next) {
    attachApiKey(req);
    next();
}
function requireApiAuth(req, res, next) {
    const apiKey = attachApiKey(req);
    if (!apiKey) {
        res.status(401).json({ error: "invalid or missing API key" });
        return;
    }
    next();
}
//# sourceMappingURL=api-auth.js.map