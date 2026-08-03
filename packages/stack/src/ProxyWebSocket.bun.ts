// Bun's native WebSocket client appends its own Host header instead of
// replacing it. The ws client used by the Node connector works under Bun and
// sends the configured Realtime tenant as the single Host value.
export { proxyWebSocketConnectorLayer } from "./ProxyWebSocket.node.ts";
