// Telegram user client (GramJS) that reaches Telegram only through the tg-user-relay Worker.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import websocket from "websocket";
import { fileURLToPath } from "node:url";
import tg from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { PromisedWebSockets } from "telegram/extensions/index.js";
import { ConnectionTCPObfuscated } from "telegram/network/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";

const { TelegramClient } = tg;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "config.json");
const SESSION = path.join(ROOT, "session.txt");

export function loadConfig() {
  return fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : {};
}

export function saveConfig(c) {
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
}

export function loadSession() {
  return fs.existsSync(SESSION) ? fs.readFileSync(SESSION, "utf8").trim() : "";
}

export function saveSession(s) {
  fs.writeFileSync(SESSION, s);
}

const NAMES = ["pluto", "venus", "aurora", "vesta", "flora"];
// Node DC addresses GramJS may still hand over (old sessions, defaults); the web names are what we use.
const IPS = {
  "149.154.175.53": 1, "149.154.175.50": 1, "149.154.175.55": 1,
  "149.154.167.51": 2, "149.154.167.50": 2, "149.154.167.41": 2,
  "149.154.175.100": 3, "149.154.175.101": 3,
  "149.154.167.91": 4, "149.154.167.92": 4,
  "91.108.56.130": 5, "91.108.56.100": 5, "91.108.56.128": 5,
};

// Bind to the real LAN card so a VPN in TUN mode (v2rayN "xray_tun") is bypassed; the relay needs no VPN.
function lanAddress() {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/tun|tap|xray|sing|wintun|vethernet|loopback|virtual/i.test(name)) continue;
    const a = (list || []).find((x) => x.family === "IPv4" && !x.internal && !x.address.startsWith("169.254."));
    if (a) return a.address;
  }
  return undefined;
}

export function makeSocketClass(cfg) {
  return class RelaySocket extends PromisedWebSockets {
    async connect(port, ip, testServers = false) {
      this.stream = Buffer.alloc(0);
      this.canRead = new Promise((resolve) => { this.resolveRead = resolve; });
      this.closed = false;
      this.website = this.getWebSocketLink(ip, port, testServers);
      const localAddress = lanAddress();
      this.client = new websocket.w3cwebsocket(this.website, "binary", undefined, undefined, localAddress ? { localAddress } : undefined);
      return new Promise((resolve, reject) => {
        this.client.onopen = () => { this.receive(); resolve(this); };
        this.client.onerror = (error) => reject(error);
        this.client.onclose = () => {
          if (this.resolveRead) this.resolveRead(false);
          this.closed = true;
        };
      });
    }
    getWebSocketLink(ip) {
      let name = ip.endsWith(".web.telegram.org") ? ip.split(".")[0] : null;
      if (!name && IPS[ip]) name = NAMES[IPS[ip] - 1];
      if (!name) throw new Error(`no relay route for ${ip}`);
      return `wss://${cfg.relayHost}/${cfg.relaySecret}/${name}/apiws`;
    }
  };
}

class RelayClient extends TelegramClient {
  // Always the web (WebSocket) DC names; the Worker maps them to wss://<dc>.web.telegram.org/apiws.
  async getDC(dcId, downloadDC = false) {
    return super.getDC(dcId, downloadDC, true);
  }
  // GramJS downloads/uploads ask getSender(homeDc), which opens a SECOND socket with the SAME auth key. Through the Worker
  // that socket can leave from another Cloudflare IP, and Telegram revokes a key seen on two IPs at once
  // (AUTH_KEY_DUPLICATED). So the home DC always reuses the main socket; other DCs get their own exported keys.
  getSender(dcId) {
    if (!dcId || dcId === this.session.dcId) return Promise.resolve(this._sender);
    return super.getSender(dcId);
  }
}

// initConnection identity: the same kind of fields official Telegram Desktop sends (config.json apiId/apiHash = TDesktop's
// public pair). Override any field with config.json -> "identity": { deviceModel, systemVersion, appVersion, ... }.
export const IDENTITY = {
  deviceModel: os.hostname(), // TDesktop sends the PC model name; set config.json "identity.deviceModel" to your machine model
  systemVersion: "Windows 11",
  appVersion: "7.3.1 x64", // a TDesktop release; bump it when Telegram Desktop updates, or set config.json identity.appVersion
  langCode: "en",
  systemLangCode: "en-US",
  langPack: "tdesktop",
};

export function makeClient(cfg, sessionString, { apiId, apiHash, floodSleepThreshold = 20 } = {}) {
  const id = { ...IDENTITY, ...(cfg.identity || {}) };
  const session = new StringSession(sessionString || "");
  const client = new RelayClient(session, Number(apiId ?? cfg.apiId ?? 0), String(apiHash ?? cfg.apiHash ?? ""), {
    connection: ConnectionTCPObfuscated,
    networkSocket: makeSocketClass(cfg),
    useWSS: true,
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
    floodSleepThreshold,
    baseLogger: new Logger(LogLevel.NONE),
    deviceModel: id.deviceModel,
    systemVersion: id.systemVersion,
    appVersion: id.appVersion,
    langCode: id.langCode,
    systemLangCode: id.systemLangCode,
  });
  // GramJS hard-codes langPack "" in its InitConnection; official apps send their pack name ("tdesktop").
  client._initRequest.langPack = id.langPack;
  if (!session.serverAddress || !session.serverAddress.endsWith(".web.telegram.org")) {
    const dc = session.dcId && session.serverAddress ? (IPS[session.serverAddress] || session.dcId) : 2;
    session.setDC(dc, `${NAMES[dc - 1]}.web.telegram.org`, 443);
  }
  return client;
}
