"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupWebSocketServer = setupWebSocketServer;
exports.broadcast = broadcast;
const ws_1 = require("ws");
const db_1 = require("./db");
let wss = null;
function getPathname(req) {
    if (!req.url) {
        return "";
    }
    try {
        return new URL(req.url, "http://localhost").pathname;
    }
    catch {
        return "";
    }
}
function setupWebSocketServer(server) {
    if (wss) {
        return wss;
    }
    wss = new ws_1.WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        if (getPathname(req) !== "/ws") {
            socket.destroy();
            return;
        }
        wss?.handleUpgrade(req, socket, head, (wsClient) => {
            wss?.emit("connection", wsClient, req);
        });
    });
    wss.on("connection", (wsClient) => {
        wsClient.send(JSON.stringify({
            event: "system:connected",
            data: { connected_at: (0, db_1.nowIso)() },
            timestamp: (0, db_1.nowIso)(),
        }));
    });
    return wss;
}
function broadcast(event, data) {
    if (!wss) {
        return;
    }
    const payload = JSON.stringify({
        event,
        data,
        timestamp: (0, db_1.nowIso)(),
    });
    for (const client of wss.clients) {
        if (client.readyState === ws_1.WebSocket.OPEN) {
            client.send(payload);
        }
    }
}
//# sourceMappingURL=ws.js.map