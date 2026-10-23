/**
 * Profile API – wallet-linked profiles with signed proof of ownership.
 * Stores profiles in PostgreSQL. Offers/escrows stay on-chain (Pact); no contract DB for profiles.
 * Run: npm run dev:server (default port 3001).
 * In dev, Vite proxies /api to this server.
 *
 * Env: DATABASE_URL (default postgresql://localhost:5432/kadena_nexus)
 *       CORS_ORIGINS – comma-separated allowed origins (e.g. https://marketplace.kadena.ws,https://kadena.ws). If unset, any origin allowed (dev).
 */

import "dotenv/config";
import { registerAlertRoutes, startAlertWatcher } from "./alerts.js";
import { registerMarketRoutes } from "./market.js";
import { registerTrustRoutes, recheckCompletedOffers, ratingSummaries } from "./trust.js";
import { registerOfferModerationRoutes, startPoolExpiryWatcher, expiryDays } from "./offerModeration.js";
import { registerCompletedFeedRoutes, completedItem } from "./completedFeed.js";
import { registerTradeEmailRoutes, emailNotification } from "./tradeEmails.js";
import { registerNotificationRoutes, startNotificationWatcher, notifyMessage, notifyTradeChangeSoon, notify, onNotificationCreated, onTradeCompleted } from "./notifications.js";
import { registerTradeTxRoutes, startTradeTxWatcher } from "./tradeTxs.js";
import { registerPayoutRoutes, readEscrowFromChain, sidesOf } from "./payout.js";
import { registerPoolRoutes } from "./pools.js";
import { createAutoRelease, registerAutoReleaseRoutes, startAutoReleaseWatcher } from "./autoRelease.js";
import { fetchChain, readTradeWithPool } from "./chain.js";
import { createChainCache } from "./trust.js";
import { registerProofRoutes } from "./proofs.js";
import { createDisputeAuthz } from "./authz.js";
import { authHeadersToQuery } from "./authHeaders.js";
import { registerShareRoutes } from "./share.js";
import { ownedFilename, mayUseAvatar, shouldDeleteOld, AVATAR_URL_PREFIX } from "./avatars.js";
import { initSessionSecret, isSessionToken, issueSessionToken, verifySessionToken } from "./session.js";
import express from "express";
import rateLimit from "express-rate-limit";
import { ipKey } from "./clientIp.js";
import cors from "cors";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import pg from "pg";
import multer from "multer";
import { hash, base64UrlDecodeArr, hexToBin, verifySig } from "@kadena/cryptography-utils";
import { createServer } from "http";
import { Server } from "socket.io";
import {
  validateBody,
  validateQuery,
  validateParams,
  walletParamSchema,
  otherWalletParamSchema,
  offerIdParamSchema,
  messageIdParamSchema,
  profilePutBodySchema,
  profileUploadAvatarBodySchema,
  profilesBulkBodySchema,
  profilesStatusBulkBodySchema,
  offersPutBodySchema,
  messagesPostBodySchema,
  messagesPostBodySchemaWithFile,
  messagesReadQuerySchema,
  messageIdReadBodySchema,
  disputeEvidenceBodySchema,
  disputesPostBodySchema,
  disputeMessageBodySchema,
  disputeActionBodySchema,
  fundTxBodySchema,
  releaseRefundTxBodySchema,
  completedOffersBodySchema,
  ratingsPostBodySchema,
  ratingsCheckQuerySchema,
  ratingsSummaryBulkBodySchema,
  offerMessagesLegacyQuerySchema,
} from "./validation.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILE_AUTH_PURPOSE = "Kadena P2P Escrow Profile";
const NONCE_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes
// Avatar: 2–5MB limit (oversized upload must fail)
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const AVATAR_MIN_BYTES = 1; // avoid empty files

/** Check file content matches allowed image types (magic bytes). Rejects renamed executables etc. */
function isAllowedImageMagic(filePath) {
  const buf = Buffer.alloc(12);
  let n;
  try {
    const fd = fs.openSync(filePath, "r");
    n = fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
  } catch (e) {
    return false;
  }
  if (n < 3) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (n >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF87a / GIF89a: 47 49 46 38 [37|39] 61
  if (n >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WebP: RIFF....WEBP (bytes 0–3 RIFF, 8–11 WEBP)
  if (n >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/** Check file content matches allowed evidence type (image or PDF magic bytes). */
function isAllowedEvidenceMagic(filePath, mimetype) {
  const buf = Buffer.alloc(12);
  let n;
  try {
    const fd = fs.openSync(filePath, "r");
    n = fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
  } catch (e) {
    return false;
  }
  if (n < 4) return false;
  if (mimetype === "application/pdf") {
    return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
  }
  return isAllowedImageMagic(filePath);
}

// Replay protection: recently used (wallet, nonce). value = expiryMs (number) or { expiry, chat?: true } for chat reuse.
const usedNonces = new Map();
function pruneUsedNonces() {
  const now = Date.now();
  for (const [key, val] of usedNonces.entries()) {
    const expiry = typeof val === "object" && val != null && "expiry" in val ? val.expiry : val;
    if (expiry <= now) usedNonces.delete(key);
  }
}
setInterval(pruneUsedNonces, 60 * 1000); // prune every minute

// PostgreSQL configuration from environment variables
// Can use either DATABASE_URL (full connection string) or individual components
const DB_HOST = process.env.DB_HOST || "localhost";
const DB_PORT = process.env.DB_PORT || "5432";
const DB_USER = process.env.DB_USER || "postgres";
const DB_PASSWORD = process.env.DB_PASSWORD || "postgres";
const DB_NAME = process.env.DB_NAME || "kadena_nexus";

// Build connection string from components if DATABASE_URL is not provided
const DATABASE_URL = process.env.DATABASE_URL || 
  `postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;

// CORS: if CORS_ORIGINS set, allow only those origins; otherwise allow any (dev)
const CORS_ORIGINS_RAW = process.env.CORS_ORIGINS;
const CORS_ALLOWED_ORIGINS = CORS_ORIGINS_RAW
  ? CORS_ORIGINS_RAW.split(",").map((s) => s.trim()).filter(Boolean)
  : null;

const UPLOADS_DIR = path.join(__dirname, "uploads", "profiles");
const EVIDENCE_DIR = path.join(__dirname, "uploads", "evidence");
const CHAT_UPLOADS_DIR = path.join(__dirname, "uploads", "chat");
try {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  console.log(`Evidence directory: ${EVIDENCE_DIR}`);
} catch (e) {
  console.error("Failed to create evidence directory:", e.message);
  process.exit(1);
}
try {
  fs.mkdirSync(CHAT_UPLOADS_DIR, { recursive: true });
  console.log(`Chat uploads directory: ${CHAT_UPLOADS_DIR}`);
} catch (e) {
  console.error("Failed to create chat uploads directory:", e.message);
  process.exit(1);
}
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  console.log(`Uploads directory: ${UPLOADS_DIR}`);
} catch (e) {
  console.error("Failed to create uploads directory:", e.message);
  process.exit(1);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        cb(null, UPLOADS_DIR);
      } catch (e) {
        cb(new Error(`Failed to create upload directory: ${e.message}`), null);
      }
    },
    // Generated filenames only (no trust of client originalname for storage)
    filename: (_req, _file, cb) => {
      cb(null, crypto.randomUUID() + ".jpg");
    },
  }),
  limits: { fileSize: AVATAR_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    // MIME check (client can lie; magic bytes checked after upload)
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Only images allowed (JPEG, PNG, GIF, WebP)"), false);
    cb(null, true);
  },
});

// Evidence upload (images and PDFs, max 10MB); generated filenames only
const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const uploadEvidence = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
        cb(null, EVIDENCE_DIR);
      } catch (e) {
        cb(new Error(`Failed to create evidence directory: ${e.message}`), null);
      }
    },
    filename: (_req, file, cb) => {
      const ext = file.mimetype === "application/pdf" ? ".pdf" : ".jpg";
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: EVIDENCE_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
    if (!allowedMimes.includes(file.mimetype)) {
      return cb(new Error("Only images (JPG, PNG, GIF, WebP) and PDFs allowed"), false);
    }
    cb(null, true);
  },
});

// Chat file upload (images and PDFs, max 5MB); optional attachment per message
const CHAT_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const uploadChatFile = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(CHAT_UPLOADS_DIR, { recursive: true });
        cb(null, CHAT_UPLOADS_DIR);
      } catch (e) {
        cb(new Error(`Failed to create chat upload directory: ${e.message}`), null);
      }
    },
    filename: (_req, file, cb) => {
      const ext = file.mimetype === "application/pdf" ? ".pdf" : ".jpg";
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: CHAT_FILE_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
    if (!allowedMimes.includes(file.mimetype)) {
      return cb(new Error("Only images (JPG, PNG, GIF, WebP) and PDFs allowed"), false);
    }
    cb(null, true);
  },
});

// Wallets without a profile get a row too, so "last active" works for every trader
const TOUCH_LAST_SEEN = "INSERT INTO profiles (wallet, last_seen) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (wallet) DO UPDATE SET last_seen = CURRENT_TIMESTAMP";
const app = express();
app.use(cors({
  origin: CORS_ALLOWED_ORIGINS?.length ? CORS_ALLOWED_ORIGINS : true,
}));
// Skip JSON body parser for multipart (so profile image + chat attachment uploads work behind Nginx)
app.use((req, res, next) => {
  const ct = req.get("Content-Type") || "";
  if (ct.toLowerCase().includes("multipart/form-data")) return next();
  express.json({ limit: "256kb" })(req, res, next);
});
// Signed proofs and session tokens come in headers (X-Nexus-*), not the address: see server/authHeaders.js
app.use(authHeadersToQuery);

// Rate limiting: 50 req/s per visitor on /api/* (50+ → 429). Keyed on the visitor's address behind Nginx
// (server/clientIp.js), not on req.ip, which is always 127.0.0.1 there.
const apiLimiter = rateLimit({
  windowMs: 1000,
  max: 50,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
});
// Chat/messages: 30 messages per minute per visitor (flexible limit)
const messagesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many message requests, please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
});
// Sign-in: 20 per minute per visitor
const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many sign-in requests, please try again in a minute." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
});
app.use("/api/messages", messagesLimiter);
app.use("/api", apiLimiter);

// Serve uploads with safe headers (nosniff to prevent MIME sniffing)
app.use("/uploads/profiles", (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}, express.static(UPLOADS_DIR));
app.use("/uploads/evidence", (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}, express.static(EVIDENCE_DIR));
app.use("/uploads/chat", (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}, express.static(CHAT_UPLOADS_DIR));

/** @type {pg.Pool} */
let pool;

// Offer alerts by email (off until RESEND_API_KEY is set)
registerAlertRoutes(app, () => pool);
// Trade notifications: in-page feed and Web Push
registerNotificationRoutes(app, () => pool, { requireAuth: (...a) => requireAuth(...a), sendAuthError: (...a) => sendAuthError(...a) });
// A trade step confirmed on the chain: tell open pages at once (they re-read that trade) and send the
// bell / push notifications now instead of at the next round.
const onTradeStepSettled = ({ offerId, ok }) => {
  if (!ok) return;
  io.emit("trade-changed", { offerId });
  notifyTradeChangeSoon();
};
registerTradeTxRoutes(app, () => pool, { onSettled: (x) => onTradeStepSettled(x), requireAuth: (...a) => requireAuth(...a), sendAuthError: (...a) => sendAuthError(...a) });
registerMarketRoutes(app);
// one cached read of the v11 chain (pools, trades, config) shared by the routes that list from it
const chainCache = createChainCache({ fetchOffers: fetchChain, freshMs: 15 * 1000 });
registerCompletedFeedRoutes(app, () => pool, { chain: chainCache });
// live "a trade was just completed" for everyone on the Marketplace (the request key may arrive a moment later)
onTradeCompleted(({ offerId, amount, wallets, trade }) => {
  setTimeout(() => completedItem(pool, offerId, amount, trade)
    .then((item) => io.emit("trade-completed", { ...item, wallets }))
    .catch((e) => console.warn("[feed]", e.message)), 3000);
});
registerTradeEmailRoutes(app, { getPool: () => pool, requireAuth: (...a) => requireAuth(...a), sendAuthError: (...a) => sendAuthError(...a) });
onNotificationCreated((row) => emailNotification(pool, row));
registerTrustRoutes(app, { getPool: () => pool, requireAuth: (...a) => requireAuth(...a), sendAuthError: (...a) => sendAuthError(...a) });
registerOfferModerationRoutes(app, { getPool: () => pool, requireAuth: (...a) => requireAuth(...a), sendAuthError: (...a) => sendAuthError(...a) });
registerPayoutRoutes(app, { getPool: () => pool, requireAuth: (...a) => requireAuth(...a), sendAuthError: (...a) => sendAuthError(...a) });
// escrow v11 pools: the market list and the per-pool payment details (server/pools.js)
registerPoolRoutes(app, { getPool: () => pool, requireAuth: (...a) => requireAuth(...a), sendAuthError: (...a) => sendAuthError(...a), chain: chainCache });
registerShareRoutes(app, { getPool: () => pool });
// auto-release of USDT/USDC trades by the platform's release agent (off unless AUTO_RELEASE_SECRET is set)
const autoRelease = createAutoRelease({ getPool: () => pool, chain: chainCache, onChange: (offerId, status) => { io.emit("trade-changed", { offerId }); if (status === "released") notifyTradeChangeSoon(); } });
registerAutoReleaseRoutes(app, { getPool: () => pool, requireAuth: (...a) => requireAuth(...a), sendAuthError: (...a) => sendAuthError(...a), auto: autoRelease });
registerProofRoutes(app, {
  getPool: () => pool,
  requireAuth: (...a) => requireAuth(...a),
  sendAuthError: (...a) => sendAuthError(...a),
  upload: uploadChatFile,
  isAllowedFile: (p, m) => isAllowedEvidenceMagic(p, m),
  // tell the seller right away (bell + phone notification)
  onAdded: ({ offerId, id, to }) => {
    if (!to) return;
    notify(pool, { wallet: to, offer_id: offerId, kind: `proof:${id}`, title: "Proof of payment added", body: "The buyer added proof of payment. Check the money arrived in your account before you release." }).catch(() => {});
  },
});

// WebSocket server for online status tracking
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CORS_ALLOWED_ORIGINS?.length ? CORS_ALLOWED_ORIGINS : true,
    methods: ["GET", "POST"],
  },
});

// Track online users: Map<wallet, { socketId, lastSeen }>
const onlineUsers = new Map();

// Socket throttling (per-socket)
const SOCKET_IDENTIFY_MIN_MS = 10 * 1000;   // 1 identify per 10s
const SOCKET_HEARTBEAT_MIN_MS = 2 * 1000;   // 1 heartbeat per 2s

// Cleanup interval: mark users offline if no heartbeat for 60 seconds
const HEARTBEAT_TIMEOUT = 60 * 1000; // 60 seconds
setInterval(() => {
  const now = Date.now();
  const toRemove = [];
  for (const [wallet, data] of onlineUsers.entries()) {
    // Check if socket is still connected
    const socket = io.sockets.sockets.get(data.socketId);
    if (!socket || !socket.connected) {
      toRemove.push(wallet);
    } else if (now - data.lastSeen > HEARTBEAT_TIMEOUT) {
      toRemove.push(wallet);
    }
  }
  for (const wallet of toRemove) {
    onlineUsers.delete(wallet);
    // Notify all clients that this user is offline
    io.emit("user-offline", { wallet });
    console.log(`User ${wallet} marked offline (timeout or disconnected)`);
  }
}, 30000); // Check every 30 seconds

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // User identifies themselves with signed proof (same profile-auth as API); verified before marking online
  socket.on("identify", async ({ wallet, publicKey, signedCmd }) => {
    const now = Date.now();
    if (socket.data.lastIdentifyAt != null && now - socket.data.lastIdentifyAt < SOCKET_IDENTIFY_MIN_MS) {
      socket.emit("error", { message: "Identify throttled; try again later." });
      return;
    }
    socket.data.lastIdentifyAt = now;

    if (!wallet || typeof wallet !== "string") {
      socket.emit("error", { message: "Invalid wallet" });
      return;
    }
    if (!publicKey || typeof publicKey !== "string") {
      socket.emit("error", { message: "Missing publicKey (required for proof of ownership)" });
      return;
    }
    if (signedCmd == null) {
      socket.emit("error", { message: "Missing signedCmd (required for proof of ownership)" });
      return;
    }
    if (isSessionToken(signedCmd)) {
      const sv = verifySessionToken(signedCmd, wallet);
      if (!sv.ok) {
        socket.emit("error", { message: "Proof of ownership failed", reason: sv.reason });
        return;
      }
    }
    let cmd = signedCmd;
    if (!isSessionToken(cmd) && typeof cmd === "string") {
      try {
        cmd = JSON.parse(cmd);
      } catch (e) {
        socket.emit("error", { message: "Invalid signedCmd JSON" });
        return;
      }
    }
    const v = isSessionToken(cmd) ? { ok: true } : verifyProfileAuth(cmd, wallet, publicKey);
    if (!v.ok) {
      socket.emit("error", { message: "Proof of ownership failed", reason: v.reason });
      return;
    }

    // Remove old socket if user reconnects (but keep the user online if it's the same wallet)
    const existing = onlineUsers.get(wallet);
    if (existing && existing.socketId !== socket.id) {
      // Disconnect old socket only if it's still connected
      const oldSocket = io.sockets.sockets.get(existing.socketId);
      if (oldSocket) {
        oldSocket.disconnect();
      }
    }

    // Mark user as online
    onlineUsers.set(wallet, {
      socketId: socket.id,
      lastSeen: Date.now(),
    });

    socket.data.wallet = wallet;
    // Join per-user room so we can push new-message to recipient even when chat isn't open
    socket.join(`user:${wallet}`);
    console.log(`User online: ${wallet}`);

    // Update last_seen in database (if column exists)
    try {
      if (pool) {
        await pool.query(
          TOUCH_LAST_SEEN,
          [wallet]
        );
      }
    } catch (err) {
      // Ignore if column doesn't exist yet (migration will add it)
      if (!err.message?.includes("does not exist")) {
        console.error("Failed to update last_seen:", err.message);
      }
    }

    // Notify all clients that this user is online (including the user themselves)
    io.emit("user-online", { wallet });
  });

  // Heartbeat to keep connection alive (throttled)
  socket.on("heartbeat", ({ wallet }) => {
    const now = Date.now();
    if (socket.data.lastHeartbeatAt != null && now - socket.data.lastHeartbeatAt < SOCKET_HEARTBEAT_MIN_MS) {
      return;
    }
    socket.data.lastHeartbeatAt = now;

    if (wallet && socket.data.wallet === wallet) {
      const userData = onlineUsers.get(wallet);
      if (userData) {
        userData.lastSeen = Date.now();
        // Update database last_seen periodically (every 5 heartbeats ~ 5 minutes)
        if (Math.random() < 0.2 && pool) {
          pool.query(
            TOUCH_LAST_SEEN,
            [wallet]
          ).catch((err) => {
            // Ignore if column doesn't exist yet
            if (!err.message?.includes("does not exist")) {
              console.error("Failed to update last_seen:", err.message);
            }
          });
        }
      }
    }
  });

  // Handle explicit logout
  socket.on("logout", ({ wallet }) => {
    if (!wallet || typeof wallet !== "string") return;
    
    const userData = onlineUsers.get(wallet);
    if (userData && userData.socketId === socket.id) {
      onlineUsers.delete(wallet);
      console.log(`User logged out: ${wallet}`);
      // Notify all clients (including the logging out user)
      io.emit("user-offline", { wallet });
    }
  });

  // Handle disconnection (network/socket disconnect)
  socket.on("disconnect", () => {
    const wallet = socket.data.wallet;
    if (wallet) {
      const userData = onlineUsers.get(wallet);
      if (userData && userData.socketId === socket.id) {
        onlineUsers.delete(wallet);
        console.log(`User offline (disconnected): ${wallet}`);
        // Notify all clients (including the disconnecting user)
        io.emit("user-offline", { wallet });
      }
    }
  });

  // Handle joining conversation room for real-time chat (user-to-user)
  socket.on("join-conversation", ({ otherWallet }) => {
    if (otherWallet && typeof otherWallet === "string" && socket.data.wallet) {
      // Create a consistent room name by sorting wallets alphabetically
      const wallets = [socket.data.wallet, otherWallet].sort();
      const roomName = `conversation:${wallets[0]}:${wallets[1]}`;
      socket.join(roomName);
      console.log(`Socket ${socket.id} (${socket.data.wallet}) joined conversation room with ${otherWallet}`);
    }
  });

  // Handle leaving conversation room
  socket.on("leave-conversation", ({ otherWallet }) => {
    if (otherWallet && typeof otherWallet === "string" && socket.data.wallet) {
      const wallets = [socket.data.wallet, otherWallet].sort();
      const roomName = `conversation:${wallets[0]}:${wallets[1]}`;
      socket.leave(roomName);
      console.log(`Socket ${socket.id} left conversation room with ${otherWallet}`);
    }
  });
});

/**
 * Verify that signedCmd was signed by the key for `wallet` and includes
 * profile-auth data with matching wallet and recent nonce.
 * Ecko may return sigs[0] with `signature` instead of `sig`, and may omit `pubKey`;
 * `bodyPublicKey` is used as fallback when pubKey is missing in sigs[0].
 * @param {object} signedCmd - { cmd, hash, sigs: [{ sig|signature, pubKey? }] }
 * @param {string} expectedWallet
 * @param {string} [bodyPublicKey] - publicKey from request body, used if sigs[0].pubKey is missing
 * @param {{ allowChatReuse?: boolean, allowProfileReuse?: boolean }} [opts] - allowChatReuse: same nonce for chat; allowProfileReuse: same nonce for upload-avatar + put profile (one sign per save)
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function verifyProfileAuth(signedCmd, expectedWallet, bodyPublicKey, opts = {}) {
  const allowChatReuse = !!opts.allowChatReuse;
  const allowProfileReuse = !!opts.allowProfileReuse;
  if (!signedCmd || typeof signedCmd !== "object") {
    return { ok: false, reason: "Missing signedCmd" };
  }
  // Ecko can return { signedCmd: { cmd, hash, sigs } }; unwrap once
  const cmdObj = signedCmd.cmd != null ? signedCmd : signedCmd.signedCmd;
  if (!cmdObj || typeof cmdObj !== "object") {
    return { ok: false, reason: "Invalid signedCmd shape" };
  }
  const { cmd, hash: hashB64, sigs } = cmdObj;
  if (typeof cmd !== "string" || typeof hashB64 !== "string" || !Array.isArray(sigs) || sigs.length === 0) {
    return { ok: false, reason: "Invalid signedCmd shape" };
  }

  const s0 = sigs[0];
  const sig = (s0 && (s0.sig ?? s0.signature)) || null;
  const pubKey = (s0 && s0.pubKey) || (typeof bodyPublicKey === "string" ? bodyPublicKey : null);
  if (!sig) {
    return { ok: false, reason: "Missing signature in sigs[0] (expected sig or signature)" };
  }
  if (!pubKey) {
    return { ok: false, reason: "Missing pubKey in sigs[0]; include publicKey in request body" };
  }

  // Only allow k: accounts; wallet must equal k:pubKey so the signer actually owns that account
  if (!expectedWallet.startsWith("k:")) {
    return { ok: false, reason: "Only k: accounts are supported for profile auth" };
  }
  if (expectedWallet !== `k:${pubKey}`) {
    return { ok: false, reason: "wallet must match k:pubKey" };
  }

  // 1) Hash(cmd) must equal stored hash
  try {
    const computed = hash(cmd);
    if (computed !== hashB64) {
      return { ok: false, reason: "Hash mismatch" };
    }
  } catch (e) {
    return { ok: false, reason: "Hash error" };
  }

  // 2) Ed25519 verify: signature over the hash
  try {
    const msgBytes = base64UrlDecodeArr(hashB64);
    const sigBytes = hexToBin(sig);
    const pubBytes = hexToBin(pubKey);
    if (!verifySig(msgBytes, sigBytes, pubBytes)) {
      return { ok: false, reason: "Invalid signature" };
    }
  } catch (e) {
    return { ok: false, reason: "Verify error" };
  }

  // 3) Parse cmd and check data["profile-auth"]
  let payload;
  try {
    const parsed = JSON.parse(cmd);
    payload = parsed?.payload;
  } catch {
    return { ok: false, reason: "Invalid cmd JSON" };
  }
  const data = payload?.exec?.data;
  const auth = data?.["profile-auth"];
  if (!auth || typeof auth !== "object") {
    return { ok: false, reason: "Missing profile-auth in signed data" };
  }
  if (auth.purpose !== PROFILE_AUTH_PURPOSE) {
    return { ok: false, reason: "Wrong purpose" };
  }
  if (auth.wallet !== expectedWallet) {
    return { ok: false, reason: "Wallet mismatch" };
  }
  const nonce = Number(auth.nonce);
  if (!Number.isFinite(nonce)) {
    return { ok: false, reason: "Invalid nonce" };
  }
  const now = Date.now();
  if (Math.abs(now - nonce) > NONCE_TOLERANCE_MS) {
    return { ok: false, reason: "Nonce expired" };
  }

  const nonceKey = `${expectedWallet}:${nonce}`;
  const existing = usedNonces.get(nonceKey);
  // peek: check without using up the nonce (sign-in reuses the caller's proof, so it stays valid for one request)
  if (opts.peek) return existing === undefined ? { ok: true } : { ok: false, reason: "Nonce already used (replay)" };
  if (existing !== undefined) {
    const entry = typeof existing === "object" && existing != null ? existing : { expiry: existing };
    if (allowChatReuse && entry.chat) return { ok: true };
    if (allowProfileReuse && entry.profile) return { ok: true };
    return { ok: false, reason: "Nonce already used (replay)" };
  }
  const expiry = now + NONCE_TOLERANCE_MS;
  usedNonces.set(nonceKey, (allowChatReuse || allowProfileReuse)
    ? { expiry, ...(allowChatReuse && { chat: true }), ...(allowProfileReuse && { profile: true }) }
    : expiry);

  return { ok: true };
}

/**
 * Require authenticated wallet from signed proof (body or query).
 * Use auth.wallet as the canonical identity; prevents wallet swap.
 * @param {object} req - Express request
 * @param {"body"|"query"} from - where to read wallet, publicKey, signedCmd
 * @param {{ allowChatReuse?: boolean, allowProfileReuse?: boolean }} [opts] - allowChatReuse / allowProfileReuse for same-nonce reuse on those flows
 * @returns {{ ok: true, wallet: string } | { ok: false, status: number, error: string, reason?: string }}
 */
function requireAuth(req, from = "body", opts = {}) {
  const data = from === "query" ? req.query : req.body;
  const wallet = data?.wallet;
  const publicKey = data?.publicKey;
  let signedCmd = data?.signedCmd;
  if (!wallet || typeof wallet !== "string") {
    return { ok: false, status: 400, error: "Missing wallet" };
  }
  if (!publicKey || typeof publicKey !== "string") {
    return { ok: false, status: 400, error: "Missing publicKey (required for proof of ownership)" };
  }
  if (signedCmd == null) {
    return { ok: false, status: 400, error: "Missing signedCmd (required for proof of ownership)" };
  }
  if (typeof signedCmd === "string" && signedCmd.startsWith('"nxs1.')) {
    try { signedCmd = JSON.parse(signedCmd); } catch { /* handled below */ }
  }
  if (isSessionToken(signedCmd)) {
    // Signed in earlier on this device (see server/session.js)
    if (opts.allowSession === false) {
      return { ok: false, status: 403, error: "Proof of ownership failed", reason: "This action needs a fresh wallet signature" };
    }
    const sv = verifySessionToken(signedCmd, wallet);
    if (!sv.ok) return { ok: false, status: 403, error: "Proof of ownership failed", reason: sv.reason };
    return { ok: true, wallet };
  }
  if (typeof signedCmd === "string") {
    try {
      signedCmd = JSON.parse(signedCmd);
    } catch (e) {
      return { ok: false, status: 400, error: "Invalid signedCmd JSON" };
    }
  }
  const v = verifyProfileAuth(signedCmd, wallet, publicKey, opts);
  if (!v.ok) {
    return { ok: false, status: 403, error: "Proof of ownership failed", reason: v.reason };
  }
  return { ok: true, wallet };
}

function sendAuthError(res, auth) {
  return res.status(auth.status).json({ error: auth.error, ...(auth.reason && { reason: auth.reason }) });
}

// Disputes are private to the two sides of the trade and the arbiter; arbiter actions are the arbiter's only.
// Who they are is read from the chain (server/authz.js).
const { requireDisputeParty, requireArbiter } = createDisputeAuthz({ getPool: () => pool, requireAuth, sendAuthError });

// POST /api/profiles/upload-avatar – multipart: image (file), wallet, publicKey, signedCmd (JSON string). Returns { url }.
app.post("/api/profiles/upload-avatar", (req, res, next) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large (max 5MB)" });
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ error: "Unexpected file field" });
      }
      return res.status(400).json({ error: err.message || "Upload error" });
    }
    next();
  });
}, validateBody(profileUploadAvatarBodySchema), async (req, res) => {
  try {
    if (!req.file) {
      console.error("POST /api/profiles/upload-avatar: No file in request (check Nginx proxy_request_buffering off and proxy_pass without trailing slash)");
      return res.status(400).json({ error: "Missing image file. If using Nginx, ensure location /api/ has proxy_request_buffering off and proxy_pass http://127.0.0.1:5050 with no trailing slash." });
    }
    // Validate magic bytes (reject renamed executables / wrong content)
    if (!isAllowedImageMagic(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
      return res.status(400).json({ error: "Invalid image file (content does not match image type)" });
    }
    const auth = requireAuth(req, "body", { allowProfileReuse: true });
    if (!auth.ok) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
      return sendAuthError(res, auth);
    }
    // the file is named after its uploader (server/avatars.js): only that wallet can show or delete it
    const filename = ownedFilename(auth.wallet);
    fs.renameSync(req.file.path, path.join(UPLOADS_DIR, filename));
    const url = AVATAR_URL_PREFIX + filename;
    console.log(`Avatar uploaded: ${url} for wallet ${auth.wallet}`);
    return res.json({ url });
  } catch (err) {
    console.error("POST /api/profiles/upload-avatar error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// GET /api/profiles/:wallet
app.get("/api/profiles/:wallet", validateParams(walletParamSchema), async (req, res) => {
  const wallet = req.params.wallet;
  try {
    // Try to select with last_seen, fallback to without if column doesn't exist
    let result;
    try {
      result = await pool.query("SELECT wallet, username, avatar, bio, updated_at, last_seen FROM profiles WHERE wallet = $1", [wallet]);
    } catch (err) {
      if (err.message?.includes("does not exist")) {
        // Column doesn't exist yet, select without it
        result = await pool.query("SELECT wallet, username, avatar, bio, updated_at FROM profiles WHERE wallet = $1", [wallet]);
      } else {
        throw err;
      }
    }
    const p = result.rows[0];
    const isOnline = onlineUsers.has(wallet);
    return res.json(p ? { 
      username: p.username, 
      avatar: p.avatar, 
      bio: p.bio, 
      wallet: p.wallet, 
      updatedAt: p.updated_at,
      lastSeen: p.last_seen || null,
      isOnline
    } : { wallet, isOnline });
  } catch (err) {
    console.error("GET /api/profiles/:wallet", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// PUT /api/profiles – create/update; requires { username, avatar?, bio?, wallet, publicKey, signedCmd }. avatar: URL (uploaded or external) or null to clear.
app.put("/api/profiles", validateBody(profilePutBodySchema), async (req, res) => {
  const auth = requireAuth(req, "body", { allowProfileReuse: true });
  if (!auth.ok) return sendAuthError(res, auth);
  if (req.body.wallet !== auth.wallet) {
    return res.status(400).json({ error: "Wallet must match authenticated wallet" });
  }
  const wallet = auth.wallet;
  const { username, avatar, bio } = req.body;

  const name = (username != null && username !== "") ? String(username).trim().slice(0, 60) : null;
  const av = (avatar != null && avatar !== "") ? String(avatar).trim().slice(0, 2048) : null;
  const b = (bio != null && bio !== "") ? String(bio).trim().slice(0, 500) : null;

  const profile = {
    username: name || null,
    avatar: av,
    bio: b || null,
    wallet,
    updatedAt: new Date().toISOString(),
  };

  try {
    // Check for existing profile to handle old avatar deletion
    const existingResult = await pool.query("SELECT avatar FROM profiles WHERE wallet = $1", [wallet]);
    const existing = existingResult.rows[0];
    const current = existing?.avatar || null;

    // an uploaded picture can only be shown by the wallet that uploaded it (server/avatars.js)
    if (!mayUseAvatar(av, current, wallet)) {
      return res.status(403).json({ error: "That picture was not uploaded by this wallet" });
    }
    // and only that wallet's own pictures are deleted when it stops showing them; a picture from before uploads
    // were tagged with their owner goes only when no other profile still shows it
    let stillShownElsewhere = false;
    if (current && current !== av) {
      stillShownElsewhere = (await pool.query("SELECT 1 FROM profiles WHERE avatar = $1 AND wallet <> $2 LIMIT 1", [current, wallet])).rows.length > 0;
    }
    if (shouldDeleteOld(current, av, wallet, stillShownElsewhere)) {
      const oldPath = path.join(UPLOADS_DIR, path.basename(current));
      try {
        fs.unlinkSync(oldPath);
      } catch (e) {
        console.warn("Could not delete old avatar file:", oldPath, e.message);
      }
    }
    
    // Upsert profile
    await pool.query(
      `INSERT INTO profiles (wallet, username, avatar, bio, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (wallet) 
       DO UPDATE SET username = $2, avatar = $3, bio = $4, updated_at = $5`,
      [wallet, profile.username, profile.avatar, profile.bio, profile.updatedAt]
    );
    
    return res.json(profile);
  } catch (err) {
    console.error("PUT /api/profiles", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/offers/:offerId – off-chain offer details (price, limits, payment method). Contract stores only trustless data.
app.get("/api/offers/:offerId", validateParams(offerIdParamSchema), async (req, res) => {
  const offerId = req.params.offerId;
  try {
    const result = await pool.query(
      `SELECT d.offer_id, d.creator, d.amount, d.side, d.price, d.min_amount, d.max_amount, d.payment_method, d.fiat_currency, d.created_at,
              GREATEST(d.created_at, x.relisted_at) AS listed_since
         FROM offer_details d LEFT JOIN offer_relists x ON x.offer_id = d.offer_id WHERE d.offer_id = $1`,
      [offerId]
    );
    const row = result.rows[0];
    if (!row) {
      // a v11 trade reference ("2:trade-…" on chain 2): price and currency are on the chain (no offer_details row); creator = the pool's creator
      const r = await readTradeWithPool(offerId).catch(() => null);
      if (!r) return res.status(404).json({ error: "Offer not found" });
      const { trade: t, pool: p } = r;
      const method = t.token ? `${t.currency} (instant)` : t.price === 0 ? "Giveaway" : t.currency;
      return res.json({
        offerId: t.tradeId, creator: p.creator, amount: t.amount, side: p.side, price: t.price, paymentMethod: JSON.stringify([method]),
        fiatCurrency: t.currency, createdAt: t.fundedAt ?? null, listedSince: null, expiryDays: 0,
        v11: true, chain: t.chain, poolId: t.poolId, seller: t.seller, buyer: t.buyer, payAmount: t.payAmount, token: t.token, payWindow: t.payWindow, agent: t.agent, state: t.state,
      });
    }
    return res.json({
      offerId: row.offer_id,
      creator: row.creator,
      amount: Number(row.amount),
      side: row.side,
      price: Number(row.price),
      paymentMethod: row.payment_method,
      fiatCurrency: row.fiat_currency,
      createdAt: row.created_at,
      // open offers leave the market OFFER_EXPIRY_DAYS after this (server/offerModeration.js)
      listedSince: row.listed_since,
      expiryDays: expiryDays(),
    });
  } catch (err) {
    console.error("GET /api/offers/:offerId", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// PUT /api/offers – upsert off-chain offer details (call before or after create-offer on chain).
// Body: { offerId, creator, amount, side, price, paymentMethod?, fiatCurrency?, wallet, publicKey, signedCmd };
// the signed-in wallet must be the creator, and an existing row can only be changed by its creator.
app.put("/api/offers", validateBody(offersPutBodySchema), async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.ok) return sendAuthError(res, auth);
  if (req.body.wallet !== auth.wallet) {
    return res.status(400).json({ error: "Wallet must match authenticated wallet" });
  }
  const { offerId, creator, amount, side, price, paymentMethod, fiatCurrency } = req.body;
  if (creator.trim() !== auth.wallet) {
    return res.status(403).json({ error: "Only the creator of an offer can save its details" });
  }
  const amt = amount;
  const pr = price;
  const pm = typeof paymentMethod === "string" ? paymentMethod : "[]";
  const fc = typeof fiatCurrency === "string" ? fiatCurrency.trim().slice(0, 10) : "USD";
  try {
    const existing = await pool.query("SELECT creator FROM offer_details WHERE offer_id = $1", [offerId.trim()]);
    if (existing.rows[0] && existing.rows[0].creator !== auth.wallet) {
      return res.status(403).json({ error: "Only the creator of an offer can save its details" });
    }
    await pool.query(
      `INSERT INTO offer_details (offer_id, creator, amount, side, price, min_amount, max_amount, payment_method, fiat_currency)
       VALUES ($1, $2, $3, $4, $5, $3, $3, $6, $7)
       ON CONFLICT (offer_id) DO UPDATE SET
         creator = EXCLUDED.creator, amount = EXCLUDED.amount, side = EXCLUDED.side,
         price = EXCLUDED.price, min_amount = EXCLUDED.min_amount, max_amount = EXCLUDED.max_amount,
         payment_method = EXCLUDED.payment_method, fiat_currency = EXCLUDED.fiat_currency`,
      [offerId.trim(), creator.trim(), amt, side, pr, pm, fc]
    );
    return res.json({ ok: true, offerId: offerId.trim() });
  } catch (err) {
    console.error("PUT /api/offers", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// PUT /api/offers/:offerId/fund-tx – save deposit (fund) transaction request key (called by seller after deposit)
app.put("/api/offers/:offerId/fund-tx", validateParams(offerIdParamSchema), validateBody(fundTxBodySchema), async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.ok) return sendAuthError(res, auth);
  if (req.body.wallet !== auth.wallet) {
    return res.status(400).json({ error: "Wallet must match authenticated wallet" });
  }
  const offerId = req.params.offerId;
  const { requestKey } = req.body;
  try {
    // only the offer's creator (the KDA holder who deposits) can record the deposit transaction
    const row = (await pool.query("SELECT creator FROM offer_details WHERE offer_id = $1", [offerId])).rows[0];
    if (!row) return res.status(404).json({ error: "Offer not found" });
    let allowed = row.creator === auth.wallet;
    if (!allowed) {
      let e;
      try { e = await readEscrowFromChain(offerId); }
      catch { return res.status(502).json({ error: "Could not check the trade on the chain. Try again." }); }
      allowed = !!e && (e.creator === auth.wallet || sidesOf(e).holder === auth.wallet);
    }
    if (!allowed) return res.status(403).json({ error: "Only the creator of this offer can save its deposit transaction" });
    await pool.query(
      "UPDATE offer_details SET fund_tx_request_key = $1 WHERE offer_id = $2",
      [requestKey.trim(), offerId]
    );
    return res.json({ ok: true, offerId });
  } catch (err) {
    console.error("PUT /api/offers/:offerId/fund-tx", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// POST /api/profiles/bulk – body: { wallets: string[] }; returns { [wallet]: ProfileSummary }
app.post("/api/profiles/bulk", validateBody(profilesBulkBodySchema), async (req, res) => {
  const list = req.body.wallets;
  try {
    // lastActive: the later of the last time the wallet was connected and its newest offer
    const result = await pool.query(
      `SELECT w AS wallet, p.username, p.avatar,
              GREATEST(p.last_seen, (SELECT max(created_at) FROM offer_details WHERE creator = w)) AS last_active
         FROM unnest($1::text[]) AS w LEFT JOIN profiles p ON p.wallet = w`,
      [list]
    );
    const out = {};
    for (const p of result.rows) {
      const isOnline = onlineUsers.has(p.wallet);
      if (p.username == null && p.avatar == null && !p.last_active && !isOnline) continue;
      out[p.wallet] = {
        username: p.username ?? null,
        avatar: p.avatar ?? null,
        wallet: p.wallet,
        isOnline,
        lastActive: isOnline ? new Date().toISOString() : p.last_active ? new Date(p.last_active).toISOString() : null,
      };
    }
    // Also include online status for wallets not in profiles
    for (const wallet of list) {
      if (!out[wallet] && onlineUsers.has(wallet)) {
        out[wallet] = { wallet, isOnline: true };
      }
    }
    return res.json(out);
  } catch (err) {
    console.error("POST /api/profiles/bulk", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/profiles/:wallet/status – get online status of a user
app.get("/api/profiles/:wallet/status", validateParams(walletParamSchema), async (req, res) => {
  const wallet = req.params.wallet;
  const isOnline = onlineUsers.has(wallet);
  return res.json({ wallet, isOnline });
});

// POST /api/profiles/status/bulk – body: { wallets: string[] }; returns { [wallet]: { isOnline: boolean } }
app.post("/api/profiles/status/bulk", validateBody(profilesStatusBulkBodySchema), async (req, res) => {
  const list = req.body.wallets;
  const out = {};
  for (const wallet of list) {
    out[wallet] = { isOnline: onlineUsers.has(wallet) };
  }
  return res.json(out);
});

/* ============================================================
   USER MESSAGES API (User-to-user conversations, not tied to specific offers)
   NOTE: Defined before DISPUTE API to avoid route conflicts
============================================================ */

// POST /api/messages – send a message (and optional file) to another user. Accepts JSON or multipart with optional "attachment".
// Use permissive multipart check so proxy/forwarded requests with boundary in Content-Type are still detected.
function isMultipartRequest(req) {
  const ct = req.get("Content-Type") || "";
  return ct.toLowerCase().includes("multipart/form-data");
}
app.post("/api/messages", (req, res, next) => {
  if (isMultipartRequest(req)) {
    uploadChatFile.single("attachment")(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File too large (max 5MB)" });
        return res.status(400).json({ error: err.message || "Upload error" });
      }
      next();
    });
  } else {
    next();
  }
}, async (req, res) => {
  const isMultipart = isMultipartRequest(req);
  if (isMultipart && req.body && typeof req.body.signedCmd === "string" && !isSessionToken(req.body.signedCmd)) {
    try {
      req.body.signedCmd = JSON.parse(req.body.signedCmd);
    } catch (_) {}
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const bodyResult = (isMultipart ? messagesPostBodySchemaWithFile : messagesPostBodySchema).safeParse(body);
  if (!bodyResult.success) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    const firstErr = bodyResult.error?.issues?.[0];
    const bodyKeys = Object.keys(body);
    const errMsg = firstErr
      ? firstErr.message
      : bodyKeys.length === 0 && isMultipart
        ? "Upload failed: form data not received. On the server, ensure Nginx location /api/ uses proxy_pass http://127.0.0.1:5050 (no trailing slash) and proxy_request_buffering off; then reload Nginx."
        : "Invalid request body";
    if (isMultipart && bodyKeys.length === 0) {
      console.warn("[POST /api/messages] multipart request had empty body (proxy may have consumed it). Send attachments directly to backend in dev.");
    }
    return res.status(400).json({ error: errMsg });
  }
  req.body = bodyResult.data;
  const auth = requireAuth(req, "body", { allowChatReuse: true });
  if (!auth.ok) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    return sendAuthError(res, auth);
  }
  if (req.body.wallet !== auth.wallet) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    return res.status(400).json({ error: "Wallet must match authenticated wallet" });
  }
  const wallet = auth.wallet;
  const { message, toWallet, contextOfferId } = req.body;
  const messageText = (message != null ? String(message) : "").trim();
  if (!messageText && !req.file) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    return res.status(400).json({ error: "Message text or file attachment required" });
  }

  const attachmentUrl = req.file ? "/uploads/chat/" + req.file.filename : null;
  const attachmentName = req.file && req.file.originalname ? req.file.originalname.slice(0, 255) : null;
  const insertMessage = messageText || (attachmentName || "Attachment");

  console.log(`[POST /api/messages] from: ${wallet}, to: ${toWallet}, attachment: ${!!req.file}`);

  try {
    if (!pool) {
      if (req.file) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      return res.status(500).json({ error: "Database not initialized" });
    }
    let result;
    try {
      result = await pool.query(
        `INSERT INTO user_messages (from_wallet, to_wallet, message, context_offer_id, attachment_url, attachment_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, from_wallet, to_wallet, message, created_at, read_at, context_offer_id, attachment_url, attachment_name`,
        [wallet, toWallet, insertMessage, contextOfferId ?? null, attachmentUrl, attachmentName, new Date().toISOString()]
      );
    } catch (tableErr) {
      if (tableErr.message?.includes("does not exist") || (tableErr.message?.includes("relation") && tableErr.message?.includes("does not exist"))) {
        if (req.file) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        console.log("user_messages table not found, using offer_messages (no attachment support)");
        result = await pool.query(
          `INSERT INTO offer_messages (offer_id, from_wallet, to_wallet, message, created_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, offer_id, from_wallet, to_wallet, message, created_at, read_at`,
          [contextOfferId || "general", wallet, toWallet, insertMessage, new Date().toISOString()]
        );
        result.rows[0].attachment_url = null;
        result.rows[0].attachment_name = null;
      } else {
        if (req.file) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        throw tableErr;
      }
    }
    const msg = result.rows[0];
    const messageData = {
      id: msg.id,
      from: msg.from_wallet,
      to: msg.to_wallet,
      message: msg.message,
      createdAt: msg.created_at,
      readAt: msg.read_at || null,
      contextOfferId: msg.context_offer_id || msg.offer_id || null,
      attachmentUrl: msg.attachment_url || null,
      attachmentName: msg.attachment_name || null,
    };
    const wallets = [wallet, toWallet].sort();
    const roomName = `conversation:${wallets[0]}:${wallets[1]}`;
    io.to(roomName).emit("new-message", messageData);
    // Notify recipient even when they don't have this conversation open (so they get toast/badge)
    io.to(`user:${messageData.to}`).emit("new-message", messageData);
    notifyMessage(() => pool, { id: messageData.id, from: messageData.from, to: messageData.to, offerId: messageData.contextOfferId });
    return res.json({
      id: msg.id,
      from: msg.from_wallet,
      to: msg.to_wallet,
      message: msg.message,
      createdAt: msg.created_at,
      readAt: msg.read_at || null,
      contextOfferId: msg.context_offer_id || msg.offer_id || null,
      attachmentUrl: msg.attachment_url || null,
      attachmentName: msg.attachment_name || null,
    });
  } catch (err) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    console.error("POST /api/messages", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/messages/unread-count – must be before /:otherWallet so "unread-count" is not captured as a wallet
// Requires wallet, publicKey, signedCmd (query) to prove requester controls wallet; only returns count for that wallet.
app.get("/api/messages/unread-count", validateQuery(messagesReadQuerySchema), async (req, res) => {
  const auth = requireAuth(req, "query", { allowChatReuse: true });
  if (!auth.ok) return sendAuthError(res, auth);
  const wallet = auth.wallet;

  try {
    let result;
    try {
      result = await pool.query(
        `SELECT COUNT(*) as count
         FROM user_messages
         WHERE to_wallet = $1 AND read_at IS NULL`,
        [wallet]
      );
    } catch (tableErr) {
      if (tableErr.message?.includes("does not exist") || (tableErr.message?.includes("relation") && tableErr.message?.includes("does not exist"))) {
        result = await pool.query(
          `SELECT COUNT(*) as count
           FROM offer_messages
           WHERE to_wallet = $1 AND read_at IS NULL`,
          [wallet]
        );
      } else {
        throw tableErr;
      }
    }

    return res.json({ unreadCount: parseInt(result.rows[0].count) || 0 });
  } catch (err) {
    console.error("GET /api/messages/unread-count", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/messages/offer/:offerId/threads – for an offer's creator: the people who wrote about this offer,
// newest first, with how many of their messages are unread. Lets the creator answer questions before anyone accepts.
app.get("/api/messages/offer/:offerId/threads", validateParams(offerIdParamSchema), validateQuery(messagesReadQuerySchema), async (req, res) => {
  const auth = requireAuth(req, "query", { allowChatReuse: true });
  if (!auth.ok) return sendAuthError(res, auth);
  if (!pool) return res.status(500).json({ error: "Database not initialized" });
  const wallet = auth.wallet;
  try {
    const { rows } = await pool.query(
      `SELECT CASE WHEN from_wallet = $1 THEN to_wallet ELSE from_wallet END AS other,
              MAX(created_at) AS last_at,
              COUNT(*) FILTER (WHERE to_wallet = $1 AND read_at IS NULL) AS unread
         FROM user_messages
        WHERE context_offer_id = $2 AND (from_wallet = $1 OR to_wallet = $1) AND from_wallet <> to_wallet
        GROUP BY 1
        ORDER BY last_at DESC
        LIMIT 50`,
      [wallet, req.params.offerId]
    );
    return res.json(rows.map((r) => ({ wallet: r.other, lastAt: r.last_at, unread: Number(r.unread) || 0 })));
  } catch (err) {
    console.error("GET /api/messages/offer/:offerId/threads", err);
    return res.status(500).json({ error: "Database error" });
  }
});

// GET /api/messages/:otherWallet – get all messages between current user and another user
// Query: wallet, publicKey, signedCmd (required – proof of ownership). Only returns messages where requester is a participant.
app.get("/api/messages/:otherWallet", validateParams(otherWalletParamSchema), validateQuery(messagesReadQuerySchema), async (req, res) => {
  const auth = requireAuth(req, "query", { allowChatReuse: true });
  if (!auth.ok) return sendAuthError(res, auth);
  const wallet = auth.wallet;
  const otherWallet = req.params.otherWallet;

  try {
    // Ensure pool is initialized
    if (!pool) {
      console.error("Database pool not initialized");
      return res.status(500).json({ error: "Database not initialized" });
    }
    
    // Try user_messages first, fallback to offer_messages
    let result;
    try {
      result = await pool.query(
        `SELECT id, from_wallet, to_wallet, message, created_at, read_at, context_offer_id, attachment_url, attachment_name
         FROM user_messages
         WHERE (from_wallet = $1 AND to_wallet = $2) OR (from_wallet = $2 AND to_wallet = $1)
         ORDER BY created_at ASC`,
        [wallet, otherWallet]
      );
    } catch (tableErr) {
      // If user_messages table doesn't exist, use offer_messages
      if (tableErr.message?.includes("does not exist") || tableErr.message?.includes("relation") && tableErr.message?.includes("does not exist")) {
        console.log("user_messages table not found, using offer_messages");
        result = await pool.query(
          `SELECT id, offer_id, from_wallet, to_wallet, message, created_at, read_at
           FROM offer_messages
           WHERE (from_wallet = $1 AND to_wallet = $2) OR (from_wallet = $2 AND to_wallet = $1)
           ORDER BY created_at ASC`,
          [wallet, otherWallet]
        );
      } else {
        throw tableErr;
      }
    }
    
    const messages = result.rows.map(row => ({
      id: row.id,
      from: row.from_wallet,
      to: row.to_wallet,
      message: row.message,
      createdAt: row.created_at,
      readAt: row.read_at || null,
      contextOfferId: row.context_offer_id || row.offer_id || null,
      attachmentUrl: row.attachment_url || null,
      attachmentName: row.attachment_name || null,
    }));
    
    return res.json(messages);
  } catch (err) {
    console.error("GET /api/messages/:otherWallet", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// PUT /api/messages/:messageId/read – mark message as read
app.put("/api/messages/:messageId/read", validateParams(messageIdParamSchema), validateBody(messageIdReadBodySchema), async (req, res) => {
  const auth = requireAuth(req, "body", { allowChatReuse: true });
  if (!auth.ok) return sendAuthError(res, auth);
  if (req.body.wallet !== auth.wallet) {
    return res.status(400).json({ error: "Wallet must match authenticated wallet" });
  }
  const wallet = auth.wallet;
  const messageId = req.params.messageId;

  try {
    // Try user_messages first, fallback to offer_messages
    let result;
    try {
      result = await pool.query(
        `UPDATE user_messages
         SET read_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND to_wallet = $2 AND read_at IS NULL
         RETURNING id, read_at`,
        [messageId, wallet]
      );
    } catch (tableErr) {
      if (tableErr.message?.includes("does not exist") || tableErr.message?.includes("relation") && tableErr.message?.includes("does not exist")) {
        result = await pool.query(
          `UPDATE offer_messages
           SET read_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND to_wallet = $2 AND read_at IS NULL
           RETURNING id, read_at`,
          [messageId, wallet]
        );
      } else {
        throw tableErr;
      }
    }
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Message not found or already read" });
    }
    
    return res.json({ id: result.rows[0].id, readAt: result.rows[0].read_at });
  } catch (err) {
    console.error("PUT /api/messages/:messageId/read", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// Legacy endpoint: POST /api/offers/:offerId/messages (for backwards compatibility)
// Redirects to POST /api/messages with contextOfferId
app.post("/api/offers/:offerId/messages", async (req, res) => {
  const offerId = req.params.offerId?.trim();
  req.body.contextOfferId = offerId;
  // Forward to the new endpoint
  return app._router.handle({ ...req, url: "/api/messages", path: "/api/messages" }, res);
});

// Legacy endpoint: GET /api/offers/:offerId/messages (for backwards compatibility)
// Gets messages between buyer and seller of the offer
app.get("/api/offers/:offerId/messages", validateParams(offerIdParamSchema), validateQuery(offerMessagesLegacyQuerySchema), async (req, res) => {
  const auth = requireAuth(req, "query");
  if (!auth.ok) return sendAuthError(res, auth);
  const wallet = auth.wallet;
  const offerId = req.params.offerId;

  // We need to find the other wallet from the offer
  // For now, we'll get all messages for this user and filter by context
  // In a real implementation, you'd query the escrow contract to get buyer/seller
  try {
    const result = await pool.query(
      `SELECT DISTINCT 
         CASE WHEN from_wallet = $1 THEN to_wallet ELSE from_wallet END as other_wallet
       FROM user_messages
       WHERE (from_wallet = $1 OR to_wallet = $1) AND context_offer_id = $2
       LIMIT 1`,
      [wallet, offerId]
    ).catch(() => ({ rows: [] }));
    
    if (result.rows.length === 0) {
      // Fallback: try to get from offer_messages
      const fallback = await pool.query(
        `SELECT DISTINCT 
           CASE WHEN from_wallet = $1 THEN to_wallet ELSE from_wallet END as other_wallet
         FROM offer_messages
         WHERE (from_wallet = $1 OR to_wallet = $1) AND offer_id = $2
         LIMIT 1`,
        [wallet, offerId]
      ).catch(() => ({ rows: [] }));
      
      if (fallback.rows.length === 0) {
        return res.json([]);
      }
      
      const otherWallet = fallback.rows[0].other_wallet;
      req.params.otherWallet = otherWallet;
      return app._router.handle({ ...req, url: `/api/messages/${otherWallet}?wallet=${wallet}`, path: `/api/messages/${otherWallet}` }, res);
    }
    
    const otherWallet = result.rows[0].other_wallet;
    req.params.otherWallet = otherWallet;
    return app._router.handle({ ...req, url: `/api/messages/${otherWallet}?wallet=${wallet}`, path: `/api/messages/${otherWallet}` }, res);
  } catch (err) {
    console.error("GET /api/offers/:offerId/messages (legacy)", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

/* ============================================================
   DISPUTE API
============================================================ */

// POST /api/disputes – open a dispute. Body: { offerId, openedBy (buyer/seller), reason, wallet, publicKey, signedCmd }
app.post("/api/disputes", validateBody(disputesPostBodySchema), async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.ok) return sendAuthError(res, auth);
  if (req.body.wallet !== auth.wallet) {
    return res.status(400).json({ error: "Wallet must match authenticated wallet" });
  }
  const wallet = auth.wallet;
  const { offerId, openedBy, reason } = req.body;
  try {
    const party = await requireDisputeParty(req, res, offerId, "body");
    if (!party.ok) return;
    const existingResult = await pool.query(
      "SELECT id FROM disputes WHERE offer_id = $1 AND status = $2",
      [offerId, "OPEN"]
    );
    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: "An open dispute already exists for this offer. Please wait for it to be resolved." });
    }
    
    const now = new Date().toISOString();
    const result = await pool.query(
      `INSERT INTO disputes (offer_id, opened_by, reason, opened_by_wallet, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, offer_id, opened_by, reason, opened_by_wallet, status, created_at, updated_at`,
      [offerId, openedBy, typeof reason === "string" ? reason.trim().slice(0, 1000) : "", wallet, "OPEN", now, now]
    );
    
    const dispute = result.rows[0];
    return res.json({
      offerId: dispute.offer_id,
      openedBy: dispute.opened_by,
      reason: dispute.reason,
      openedByWallet: dispute.opened_by_wallet,
      status: dispute.status,
      createdAt: dispute.created_at,
      updatedAt: dispute.updated_at,
    });
  } catch (err) {
    console.error("POST /api/disputes", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/disputes – list all disputes (for admin/arbiter panel). Query: ?status=OPEN|UNDER_REVIEW|CLOSED
app.get("/api/disputes", async (req, res) => {
  const statusFilter = req.query.status?.toString()?.toUpperCase();
  const validStatuses = ["OPEN", "UNDER_REVIEW", "CLOSED"];
  const status = statusFilter && validStatuses.includes(statusFilter) ? statusFilter : null;
  try {
    let result;
    try {
      result = await pool.query(
        `SELECT id, offer_id, opened_by, reason, opened_by_wallet, status, triggered_by_timeout, created_at, updated_at
         FROM disputes ${status ? "WHERE status = $1" : ""} ORDER BY created_at DESC`,
        status ? [status] : []
      );
    } catch (e) {
      if (e.message?.includes("triggered_by_timeout")) {
        result = await pool.query(
          `SELECT id, offer_id, opened_by, reason, opened_by_wallet, status, created_at, updated_at
           FROM disputes ${status ? "WHERE status = $1" : ""} ORDER BY created_at DESC`,
          status ? [status] : []
        );
        result.rows = result.rows.map((r) => ({ ...r, triggered_by_timeout: false }));
      } else throw e;
    }
    const list = result.rows.map((r) => ({
      id: r.id,
      offerId: r.offer_id,
      openedBy: r.opened_by,
      reason: r.reason || null,
      openedByWallet: r.opened_by_wallet,
      status: r.status,
      triggeredByTimeout: !!r.triggered_by_timeout,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return res.json(list);
  } catch (err) {
    console.error("GET /api/disputes", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/disputes/:offerId – get dispute for an offer (includes fundTxRequestKey from offer_details, releaseRefundTxRequestKey from disputes)
app.get("/api/disputes/:offerId", validateParams(offerIdParamSchema), async (req, res) => {
  const offerId = req.params.offerId;
  try {
    let result;
    try {
      result = await pool.query(
        "SELECT id, offer_id, opened_by, reason, opened_by_wallet, status, triggered_by_timeout, release_refund_tx_request_key, created_at, updated_at FROM disputes WHERE offer_id = $1",
        [offerId]
      );
    } catch (e) {
      if (e.message?.includes("release_refund_tx_request_key")) {
        result = await pool.query(
          "SELECT id, offer_id, opened_by, reason, opened_by_wallet, status, triggered_by_timeout, created_at, updated_at FROM disputes WHERE offer_id = $1",
          [offerId]
        );
        if (result.rows[0]) result.rows[0].release_refund_tx_request_key = null;
      } else if (e.message?.includes("triggered_by_timeout")) {
        result = await pool.query(
          "SELECT id, offer_id, opened_by, reason, opened_by_wallet, status, created_at, updated_at FROM disputes WHERE offer_id = $1",
          [offerId]
        );
        if (result.rows[0]) {
          result.rows[0].triggered_by_timeout = false;
          result.rows[0].release_refund_tx_request_key = null;
        }
      } else throw e;
    }
    // 200 + null: no dispute row yet (normal for almost all offers). Avoids noisy browser 404 on every poll.
    if (result.rows.length === 0) {
      return res.status(200).json(null);
    }
    const dispute = result.rows[0];
    let fundTxRequestKey = null;
    try {
      const offerRow = await pool.query(
        "SELECT fund_tx_request_key FROM offer_details WHERE offer_id = $1",
        [offerId]
      );
      if (offerRow.rows[0]?.fund_tx_request_key) fundTxRequestKey = offerRow.rows[0].fund_tx_request_key;
    } catch (colErr) {
      if (!colErr.message?.includes("fund_tx_request_key")) throw colErr;
    }
    return res.json({
      offerId: dispute.offer_id,
      openedBy: dispute.opened_by,
      reason: dispute.reason,
      openedByWallet: dispute.opened_by_wallet,
      status: dispute.status,
      triggeredByTimeout: !!dispute.triggered_by_timeout,
      fundTxRequestKey: fundTxRequestKey || null,
      releaseRefundTxRequestKey: dispute.release_refund_tx_request_key || null,
      createdAt: dispute.created_at,
      updatedAt: dispute.updated_at,
    });
  } catch (err) {
    console.error("GET /api/disputes/:offerId", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// POST /api/disputes/:offerId/evidence – submit evidence. Multipart: file(s), explanation, wallet, publicKey, signedCmd
app.post("/api/disputes/:offerId/evidence", validateParams(offerIdParamSchema), (req, res, next) => {
  uploadEvidence.array("files", 10)(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large (max 10MB per file)" });
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ error: "Unexpected file field" });
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({ error: "Too many files (max 10)" });
      }
      return res.status(400).json({ error: err.message || "Upload error" });
    }
    next();
  });
}, validateBody(disputeEvidenceBodySchema), async (req, res) => {
  try {
    const offerId = req.params.offerId;
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }
    // Validate magic bytes for each file (reject renamed executables / wrong content)
    for (const f of files) {
      if (!isAllowedEvidenceMagic(f.path, f.mimetype)) {
        for (const x of files) {
          try { fs.unlinkSync(x.path); } catch (e) { /* ignore */ }
        }
        return res.status(400).json({ error: "Invalid file (content does not match declared type)" });
      }
    }
    const auth = requireAuth(req);
    if (!auth.ok) {
      for (const f of files) {
        try { fs.unlinkSync(f.path); } catch (e) { /* ignore */ }
      }
      return sendAuthError(res, auth);
    }
    if (req.body.wallet !== auth.wallet) {
      for (const f of files) {
        try { fs.unlinkSync(f.path); } catch (e) { /* ignore */ }
      }
      return res.status(400).json({ error: "Wallet must match authenticated wallet" });
    }
    const wallet = auth.wallet;
    const { explanation } = req.body;
    // Check if dispute exists
    const disputeResult = await pool.query("SELECT id FROM disputes WHERE offer_id = $1", [offerId]);
    if (disputeResult.rows.length === 0) {
      for (const f of files) { try { fs.unlinkSync(f.path); } catch (e) { /* ignore */ } }
      return res.status(404).json({ error: "Dispute not found" });
    }
    // Only the two sides and the arbiter (read from the chain)
    const party = await requireDisputeParty(req, res, offerId, "body");
    if (!party.ok) {
      for (const f of files) { try { fs.unlinkSync(f.path); } catch (e) { /* ignore */ } }
      return;
    }
    const evidenceFiles = files.map((f) => ({
      filename: f.filename,
      originalName: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
      url: `/uploads/evidence/${f.filename}`,
    }));
    
    const result = await pool.query(
      `INSERT INTO evidence (offer_id, submitted_by, explanation, files, submitted_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, offer_id, submitted_by, explanation, files, submitted_at`,
      [
        offerId,
        wallet,
        (explanation != null && String(explanation).trim()) ? String(explanation).trim().slice(0, 2000) : "",
        JSON.stringify(evidenceFiles),
        new Date().toISOString(),
      ]
    );
    
    await pool.query(
      "UPDATE disputes SET updated_at = $1 WHERE offer_id = $2",
      [new Date().toISOString(), offerId]
    );
    
    const evidence = result.rows[0];
    return res.json({
      offerId: evidence.offer_id,
      submittedBy: evidence.submitted_by,
      explanation: evidence.explanation,
      files: evidence.files,
      submittedAt: evidence.submitted_at,
    });
  } catch (err) {
    console.error("POST /api/disputes/:offerId/evidence", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// GET /api/disputes/:offerId/evidence – get all evidence for a dispute. Query: ?wallet=<wallet> (for authorization check)
app.get("/api/disputes/:offerId/evidence", validateParams(offerIdParamSchema), async (req, res) => {
  const offerId = req.params.offerId;
  try {
    const party = await requireDisputeParty(req, res, offerId, "query");
    if (!party.ok) return;
    const disputeResult = await pool.query("SELECT id FROM disputes WHERE offer_id = $1", [offerId]);
    if (disputeResult.rows.length === 0) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    const result = await pool.query(
      "SELECT id, offer_id, submitted_by, explanation, files, submitted_at FROM evidence WHERE offer_id = $1 ORDER BY submitted_at DESC",
      [offerId]
    );
    const evidenceList = result.rows.map(row => ({
      offerId: row.offer_id,
      submittedBy: row.submitted_by,
      explanation: row.explanation,
      files: row.files,
      submittedAt: row.submitted_at,
    }));
    return res.json(evidenceList);
  } catch (err) {
    console.error("GET /api/disputes/:offerId/evidence", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// POST /api/disputes/:offerId/messages – send a message in dispute. Body: { message, wallet, publicKey, signedCmd }
app.post("/api/disputes/:offerId/messages", validateParams(offerIdParamSchema), validateBody(disputeMessageBodySchema), async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.ok) return sendAuthError(res, auth);
  if (req.body.wallet !== auth.wallet) {
    return res.status(400).json({ error: "Wallet must match authenticated wallet" });
  }
  const wallet = auth.wallet;
  const offerId = req.params.offerId;
  const { message } = req.body;
  try {
    const disputeResult = await pool.query("SELECT id FROM disputes WHERE offer_id = $1", [offerId]);
    if (disputeResult.rows.length === 0) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    const party = await requireDisputeParty(req, res, offerId, "body");
    if (!party.ok) return;
    
    const result = await pool.query(
      `INSERT INTO dispute_messages (offer_id, from_wallet, message, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, offer_id, from_wallet, message, created_at`,
      [offerId, wallet, message.trim(), new Date().toISOString()]
    );
    
    await pool.query(
      "UPDATE disputes SET updated_at = $1 WHERE offer_id = $2",
      [new Date().toISOString(), offerId]
    );
    
    const msg = result.rows[0];
    return res.json({
      offerId: msg.offer_id,
      from: msg.from_wallet,
      message: msg.message,
      createdAt: msg.created_at,
    });
  } catch (err) {
    console.error("POST /api/disputes/:offerId/messages", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/disputes/:offerId/messages – get all messages in dispute
app.get("/api/disputes/:offerId/messages", validateParams(offerIdParamSchema), async (req, res) => {
  const offerId = req.params.offerId;
  try {
    const party = await requireDisputeParty(req, res, offerId, "query");
    if (!party.ok) return;
    const disputeResult = await pool.query("SELECT id FROM disputes WHERE offer_id = $1", [offerId]);
    if (disputeResult.rows.length === 0) {
      console.log(`[GET /api/disputes/:offerId/messages] Dispute not found for offerId: ${offerId}`);
      return res.status(404).json({ error: "Dispute not found" });
    }
    
    const result = await pool.query(
      "SELECT id, offer_id, from_wallet, message, created_at FROM dispute_messages WHERE offer_id = $1 ORDER BY created_at ASC",
      [offerId]
    );
    
    const messages = result.rows.map(row => ({
      offerId: row.offer_id,
      from: row.from_wallet,
      message: row.message,
      createdAt: row.created_at,
    }));
    
    return res.json(messages);
  } catch (err) {
    console.error("GET /api/disputes/:offerId/messages", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/disputes/:offerId/actions – action log for admin (request_info, under_review, resolved)
app.get("/api/disputes/:offerId/actions", validateParams(offerIdParamSchema), async (req, res) => {
  const offerId = req.params.offerId;
  try {
    const result = await pool.query(
      "SELECT id, offer_id, action_type, by_wallet, payload, created_at FROM dispute_actions WHERE offer_id = $1 ORDER BY created_at ASC",
      [offerId]
    ).catch((e) => {
      if (e.message?.includes("dispute_actions")) return { rows: [] };
      throw e;
    });
    const actions = result.rows.map((r) => ({
      id: r.id,
      offerId: r.offer_id,
      actionType: r.action_type,
      byWallet: r.by_wallet,
      payload: r.payload || null,
      createdAt: r.created_at,
    }));
    return res.json(actions);
  } catch (err) {
    console.error("GET /api/disputes/:offerId/actions", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// PUT /api/disputes/:offerId/review – arbiter marks dispute under review. Body: { wallet, publicKey, signedCmd }
app.put("/api/disputes/:offerId/review", validateParams(offerIdParamSchema), validateBody(disputeActionBodySchema), async (req, res) => {
  const offerId = req.params.offerId;
  const arb = await requireArbiter(req, res, offerId, "body");
  if (!arb.ok) return;
  const wallet = arb.wallet;
  try {
    const disputeResult = await pool.query("SELECT status FROM disputes WHERE offer_id = $1", [offerId]);
    if (disputeResult.rows.length === 0) return res.status(404).json({ error: "Dispute not found" });
    const dispute = disputeResult.rows[0];
    if (dispute.status !== "OPEN" && dispute.status !== "UNDER_REVIEW") {
      return res.status(400).json({ error: "Dispute is already closed" });
    }
    await pool.query(
      "UPDATE disputes SET status = $1, updated_at = $2 WHERE offer_id = $3",
      ["UNDER_REVIEW", new Date().toISOString(), offerId]
    );
    await pool.query(
      "INSERT INTO dispute_actions (offer_id, action_type, by_wallet, payload) VALUES ($1, $2, $3, $4)",
      [offerId, "under_review", wallet.trim(), JSON.stringify({ at: new Date().toISOString() })]
    ).catch(() => {});
    return res.json({ success: true, status: "UNDER_REVIEW" });
  } catch (err) {
    console.error("PUT /api/disputes/:offerId/review", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// POST /api/disputes/:offerId/request-info – arbiter requests more info. Body: { message?, wallet, publicKey, signedCmd }
app.post("/api/disputes/:offerId/request-info", validateParams(offerIdParamSchema), validateBody(disputeActionBodySchema), async (req, res) => {
  const offerId = req.params.offerId;
  const arb = await requireArbiter(req, res, offerId, "body");
  if (!arb.ok) return;
  const wallet = arb.wallet;
  const { message } = req.body;
  try {
    const disputeResult = await pool.query("SELECT id FROM disputes WHERE offer_id = $1", [offerId]);
    if (disputeResult.rows.length === 0) return res.status(404).json({ error: "Dispute not found" });
    const msg = typeof message === "string" ? message.trim().slice(0, 1000) : null;
    await pool.query(
      "INSERT INTO dispute_actions (offer_id, action_type, by_wallet, payload) VALUES ($1, $2, $3, $4)",
      [offerId, "request_info", wallet.trim(), JSON.stringify({ message: msg || "Arbiter requested more information.", at: new Date().toISOString() })]
    ).catch(() => {});
    if (msg) {
      await pool.query(
        "INSERT INTO dispute_messages (offer_id, from_wallet, message) VALUES ($1, $2, $3)",
        [offerId, wallet.trim(), `[Arbiter] ${msg}`]
      );
      await pool.query("UPDATE disputes SET updated_at = $1 WHERE offer_id = $2", [new Date().toISOString(), offerId]);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("POST /api/disputes/:offerId/request-info", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// PUT /api/disputes/:offerId/close – arbiter closes dispute. Body: { wallet, publicKey, signedCmd }
app.put("/api/disputes/:offerId/close", validateParams(offerIdParamSchema), validateBody(disputeActionBodySchema), async (req, res) => {
  const offerId = req.params.offerId;
  const arb = await requireArbiter(req, res, offerId, "body");
  if (!arb.ok) return;
  const wallet = arb.wallet;
  try {
    const disputeResult = await pool.query("SELECT status FROM disputes WHERE offer_id = $1", [offerId]);
    if (disputeResult.rows.length === 0) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    const dispute = disputeResult.rows[0];
    if (dispute.status !== "OPEN" && dispute.status !== "UNDER_REVIEW") {
      return res.status(400).json({ error: "Dispute is already closed" });
    }
    await pool.query(
      "UPDATE disputes SET status = $1, updated_at = $2 WHERE offer_id = $3",
      ["CLOSED", new Date().toISOString(), offerId]
    );
    await pool.query(
      "INSERT INTO dispute_actions (offer_id, action_type, by_wallet, payload) VALUES ($1, $2, $3, $4)",
      [offerId, "resolved", wallet.trim(), JSON.stringify({ at: new Date().toISOString() })]
    ).catch(() => {});
    return res.json({ success: true, status: "CLOSED" });
  } catch (err) {
    console.error("PUT /api/disputes/:offerId/close", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// PUT /api/disputes/:offerId/release-refund-tx – save release or refund transaction request key (called by arbiter after release/refund)
app.put("/api/disputes/:offerId/release-refund-tx", validateParams(offerIdParamSchema), validateBody(releaseRefundTxBodySchema), async (req, res) => {
  const offerId = req.params.offerId;
  const arb = await requireArbiter(req, res, offerId, "body");
  if (!arb.ok) return;
  const { requestKey } = req.body;
  try {
    const disputeResult = await pool.query("SELECT id FROM disputes WHERE offer_id = $1", [offerId]);
    if (disputeResult.rows.length === 0) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    await pool.query(
      "UPDATE disputes SET release_refund_tx_request_key = $1, updated_at = $2 WHERE offer_id = $3",
      [requestKey.trim(), new Date().toISOString(), offerId]
    );
    return res.json({ ok: true, offerId });
  } catch (err) {
    console.error("PUT /api/disputes/:offerId/release-refund-tx", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

/* ============================================================
   RATINGS & REPUTATION ENFORCEMENT
   - Only allow rating after a completed trade (completed_offers).
   - One rating per party per trade: UNIQUE(offer_id, rater_wallet).
   - No self-rating: ratedWallet must be the counterparty.
   - Expose: trade counts, completion counts, dispute counts, rating aggregates
     (GET summary, bulk summary, and per-trade ratings for UI/integrity).
============================================================ */

// POST /api/completed-offers – register a completed trade (buyer or seller). Body: { offerId, buyerWallet, sellerWallet, wallet, publicKey, signedCmd }
app.post("/api/completed-offers", validateBody(completedOffersBodySchema), async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.ok) return sendAuthError(res, auth);
  if (req.body.wallet !== auth.wallet) {
    return res.status(400).json({ error: "Wallet must match authenticated wallet" });
  }
  const wallet = auth.wallet;
  const offerId = req.body.offerId.trim();
  try {
    // Ratings are only for real trades: the trade must be COMPLETED on the chain, and the two wallets
    // are taken from the chain (not from the request), so nobody can invent a trade to rate a friend.
    let e;
    try { e = await readEscrowFromChain(offerId); }
    catch { return res.status(502).json({ error: "Could not check the trade on the chain. Try again." }); }
    if (!e) return res.status(404).json({ error: "Trade not found on the chain" });
    if (e.state !== "COMPLETED") return res.status(409).json({ error: "Only completed trades can be rated" });
    const { holder: sellerWallet, payer: buyerWallet } = sidesOf(e);
    if (!sellerWallet || !buyerWallet) return res.status(409).json({ error: "This trade has no buyer on the chain" });
    if (wallet !== buyerWallet && wallet !== sellerWallet) {
      return res.status(403).json({ error: "Wallet must be buyer or seller for this offer" });
    }
    await pool.query(
      `INSERT INTO completed_offers (offer_id, buyer_wallet, seller_wallet)
       VALUES ($1, $2, $3)
       ON CONFLICT (offer_id) DO NOTHING`,
      [offerId, buyerWallet, sellerWallet]
    );
    return res.json({ ok: true, offerId });
  } catch (err) {
    console.error("POST /api/completed-offers", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// POST /api/ratings – submit a rating (enforcement: completed trade only, one per party, no self-rating)
app.post("/api/ratings", validateBody(ratingsPostBodySchema), async (req, res) => {
  const auth = requireAuth(req);
  if (!auth.ok) return sendAuthError(res, auth);
  if (req.body.wallet !== auth.wallet) {
    return res.status(400).json({ error: "Wallet must match authenticated wallet" });
  }
  const wallet = auth.wallet;
  const { offerId, ratedWallet, rating, comment } = req.body;
  const r = rating;
  try {
    // Enforcement: only allow rating after a completed trade
    const row = await pool.query(
      "SELECT buyer_wallet, seller_wallet FROM completed_offers WHERE offer_id = $1",
      [offerId.trim()]
    );
    if (row.rows.length === 0) {
      return res.status(400).json({ error: "Offer not found as completed; complete the trade first" });
    }
    const { buyer_wallet, seller_wallet } = row.rows[0];
    if (wallet !== buyer_wallet && wallet !== seller_wallet) {
      return res.status(403).json({ error: "Only buyer or seller can rate this trade" });
    }
    if (ratedWallet !== buyer_wallet && ratedWallet !== seller_wallet) {
      return res.status(400).json({ error: "ratedWallet must be the other party (buyer or seller)" });
    }
    // Enforcement: no self-rating
    if (ratedWallet === wallet) {
      return res.status(400).json({ error: "Cannot rate yourself" });
    }
    const commentTrim = typeof comment === "string" ? comment.trim().slice(0, 500) : null;
    await pool.query(
      `INSERT INTO ratings (offer_id, rater_wallet, rated_wallet, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (offer_id, rater_wallet) DO UPDATE SET rating = $4, comment = $5, created_at = CURRENT_TIMESTAMP`,
      [offerId.trim(), wallet.trim(), ratedWallet.trim(), Math.round(r), commentTrim]
    );
    return res.json({ ok: true, offerId: offerId.trim() });
  } catch (err) {
    console.error("POST /api/ratings", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/ratings/trade/:offerId – per-trade ratings for UI/integrity (trade counts, who rated whom)
app.get("/api/ratings/trade/:offerId", validateParams(offerIdParamSchema), async (req, res) => {
  const offerId = req.params.offerId;
  try {
    const completed = await pool.query(
      "SELECT offer_id, buyer_wallet, seller_wallet, completed_at FROM completed_offers WHERE offer_id = $1",
      [offerId]
    );
    const trade = completed.rows[0] || null;
    const ratingsResult = await pool.query(
      "SELECT rater_wallet, rated_wallet, rating, comment, created_at FROM ratings WHERE offer_id = $1 ORDER BY created_at",
      [offerId]
    );
    const ratings = ratingsResult.rows.map((r) => ({
      raterWallet: r.rater_wallet,
      ratedWallet: r.rated_wallet,
      rating: r.rating,
      comment: r.comment || null,
      createdAt: r.created_at,
    }));
    return res.json({
      offerId,
      trade: trade ? { buyerWallet: trade.buyer_wallet, sellerWallet: trade.seller_wallet, completedAt: trade.completed_at } : null,
      ratings,
      ratingCount: ratings.length,
    });
  } catch (err) {
    console.error("GET /api/ratings/trade/:offerId", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/ratings/summary/:wallet – UI/hybrid: trade counts, completion counts, dispute counts, rating aggregates
app.get("/api/ratings/summary/:wallet", validateParams(walletParamSchema), async (req, res) => {
  const wallet = req.params.wallet;
  try {
    return res.json((await ratingSummaries(pool, [wallet]))[wallet]);
  } catch (err) {
    console.error("GET /api/ratings/summary/:wallet", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// POST /api/ratings/summary/bulk – body: { wallets: string[] }; returns { [wallet]: { averageRating, totalRatings, completedTrades, disputedCount, completionRate } }
// Three grouped queries for the whole list (server/trust.js), not three per wallet.
app.post("/api/ratings/summary/bulk", validateBody(ratingsSummaryBulkBodySchema), async (req, res) => {
  const list = req.body.wallets;
  if (list.length === 0) return res.json({});
  try {
    return res.json(await ratingSummaries(pool, list));
  } catch (err) {
    console.error("POST /api/ratings/summary/bulk", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// GET /api/ratings/check – query: offerId, wallet – returns { canRate: boolean, alreadyRated: boolean }
app.get("/api/ratings/check", validateQuery(ratingsCheckQuerySchema), async (req, res) => {
  const offerId = req.query.offerId;
  const wallet = req.query.wallet;
  try {
    const completed = await pool.query(
      "SELECT 1 FROM completed_offers WHERE offer_id = $1 AND (buyer_wallet = $2 OR seller_wallet = $2)",
      [offerId, wallet]
    );
    if (completed.rows.length === 0) {
      return res.json({ canRate: false, alreadyRated: false });
    }
    const existing = await pool.query(
      "SELECT 1 FROM ratings WHERE offer_id = $1 AND rater_wallet = $2",
      [offerId, wallet]
    );
    return res.json({ canRate: true, alreadyRated: existing.rows.length > 0 });
  } catch (err) {
    console.error("GET /api/ratings/check", err);
    return res.status(500).json({ error: err.message || "Database error" });
  }
});

// POST /api/session – sign in once per device. Body: { wallet, publicKey, signedCmd } (a fresh signature).
// Returns { token, expiresAt }; the browser then sends the token as signedCmd instead of signing again.
app.post("/api/session", sessionLimiter, (req, res) => {
  const auth = requireAuth(req, "body", { allowSession: false, peek: true });
  if (!auth.ok) return sendAuthError(res, auth);
  try {
    return res.json(issueSessionToken(auth.wallet));
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
});

// GET /api/session/check?wallet=&token= – is this device still signed in?
app.get("/api/session/check", sessionLimiter, (req, res) => {
  const { wallet, token } = req.query;
  if (typeof wallet !== "string" || typeof token !== "string") return res.status(400).json({ ok: false });
  const v = verifySessionToken(token, wallet);
  return res.json({ ok: v.ok, ...(v.ok ? {} : { reason: v.reason }) });
});

const PORT = Number(process.env.PORT) || 3001;

function splitSqlStatements(sql) {
  const statements = [];
  let statementStart = 0;
  let inSingleQuotedString = false;
  let singleQuotedStringUsesBackslashEscapes = false;
  let inDoubleQuotedIdentifier = false;
  let inLineComment = false;
  let blockCommentDepth = 0;
  let dollarQuoteDelimiter = null;

  for (let i = 0; i < sql.length;) {
    const current = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (current === "\n") inLineComment = false;
      i++;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (current === "/" && next === "*") {
        blockCommentDepth++;
        i += 2;
      } else if (current === "*" && next === "/") {
        blockCommentDepth--;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (dollarQuoteDelimiter) {
      if (sql.startsWith(dollarQuoteDelimiter, i)) {
        i += dollarQuoteDelimiter.length;
        dollarQuoteDelimiter = null;
      } else {
        i++;
      }
      continue;
    }

    if (inSingleQuotedString) {
      if (singleQuotedStringUsesBackslashEscapes && current === "\\") {
        i = Math.min(i + 2, sql.length);
      } else if (current === "'" && next === "'") {
        i += 2;
      } else {
        if (current === "'") inSingleQuotedString = false;
        i++;
      }
      continue;
    }

    if (inDoubleQuotedIdentifier) {
      if (current === '"' && next === '"') {
        i += 2;
      } else {
        if (current === '"') inDoubleQuotedIdentifier = false;
        i++;
      }
      continue;
    }

    if (current === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (current === "/" && next === "*") {
      blockCommentDepth = 1;
      i += 2;
      continue;
    }
    if (current === "'") {
      const previous = sql[i - 1];
      const beforePrevious = sql[i - 2];
      singleQuotedStringUsesBackslashEscapes =
        /[eE]/.test(previous || "") &&
        (!beforePrevious || !/[A-Za-z0-9_$]/.test(beforePrevious));
      inSingleQuotedString = true;
      i++;
      continue;
    }
    if (current === '"') {
      inDoubleQuotedIdentifier = true;
      i++;
      continue;
    }
    if (current === "$") {
      const delimiter = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        dollarQuoteDelimiter = delimiter;
        i += delimiter.length;
        continue;
      }
    }
    if (current === ";") {
      const statement = sql.slice(statementStart, i + 1).trim();
      if (statement) statements.push(statement);
      statementStart = i + 1;
    }
    i++;
  }

  if (inSingleQuotedString || inDoubleQuotedIdentifier || blockCommentDepth > 0 || dollarQuoteDelimiter) {
    throw new Error("Unterminated quote or comment in server/schema.sql");
  }

  const remainder = sql.slice(statementStart).trim();
  if (remainder) statements.push(remainder);
  return statements;
}

async function initializeSchema() {
  const schemaPath = path.join(__dirname, "schema.sql");
  if (!fs.existsSync(schemaPath)) {
    console.error(`Schema file not found: ${schemaPath}`);
    throw new Error("Schema file not found");
  }
  
  const schemaSQL = fs.readFileSync(schemaPath, "utf-8");
  
  const statements = splitSqlStatements(schemaSQL);
  
  // Execute each statement
  console.log(`Executing ${statements.length} schema statements...`);
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    if (statement.length === 0) continue;
    
    try {
      await pool.query(statement);
      console.log(`  ✓ Executed schema statement ${i + 1}`);
    } catch (err) {
      // Ignore "already exists" errors for tables/indexes
      const isAlreadyExists = err.message.includes("already exists") || err.code === "42P07";
      if (isAlreadyExists) {
        console.log(`  ⊙ Schema statement ${i + 1} already exists`);
      } else {
        console.error(`  ✗ Schema initialization error on statement ${i + 1}:`, err.message);
        console.error("  Failed statement:", statement.substring(0, 150));
        // Don't throw - continue with other statements
        console.warn("  Continuing with remaining statements...");
      }
    }
  }
  
  // Ensure last_seen column exists (migration for existing databases)
  try {
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'profiles' AND column_name = 'last_seen'
    `);
    if (columnCheck.rows.length === 0) {
      console.log("  Adding last_seen column to profiles table...");
      await pool.query("ALTER TABLE profiles ADD COLUMN last_seen TIMESTAMP WITH TIME ZONE");
      console.log("  ✓ Added last_seen column");
    } else {
      console.log("  ⊙ last_seen column already exists");
    }
  } catch (err) {
    console.error("  ✗ Failed to add last_seen column:", err.message);
    // Don't throw - this is a migration, not critical for startup
  }

  // Ensure user_messages table exists (new user-to-user messaging system)
  try {
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_name = 'user_messages'
    `);
    if (tableCheck.rows.length === 0) {
      console.log("  Creating user_messages table...");
      await pool.query(`
        CREATE TABLE user_messages (
          id SERIAL PRIMARY KEY,
          from_wallet VARCHAR(255) NOT NULL,
          to_wallet VARCHAR(255) NOT NULL,
          message TEXT NOT NULL CHECK (char_length(message) <= 2000),
          read_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
          context_offer_id VARCHAR(255),
          attachment_url VARCHAR(512),
          attachment_name VARCHAR(255)
        )
      `);
      await pool.query(`CREATE INDEX idx_user_messages_from_wallet ON user_messages(from_wallet)`);
      await pool.query(`CREATE INDEX idx_user_messages_to_wallet ON user_messages(to_wallet)`);
      await pool.query(`CREATE INDEX idx_user_messages_created_at ON user_messages(created_at)`);
      await pool.query(`CREATE INDEX idx_user_messages_context_offer ON user_messages(context_offer_id)`);
      await pool.query(`CREATE INDEX idx_user_messages_from_to_created ON user_messages(from_wallet, to_wallet, created_at)`);
      await pool.query(`CREATE INDEX idx_user_messages_to_wallet_read_at ON user_messages(to_wallet, read_at)`);
      await pool.query(`
        CREATE INDEX idx_user_messages_conversation ON user_messages(
          LEAST(from_wallet, to_wallet), 
          GREATEST(from_wallet, to_wallet), 
          created_at
        )
      `);
      console.log("  ✓ Created user_messages table");
    } else {
      console.log("  ⊙ user_messages table already exists");
      // Migration: add attachment columns if missing (for existing installs)
      try {
        await pool.query("ALTER TABLE user_messages ADD COLUMN IF NOT EXISTS attachment_url VARCHAR(512)");
        await pool.query("ALTER TABLE user_messages ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255)");
      } catch (migErr) {
        console.warn("  user_messages attachment columns migration:", migErr.message);
      }
    }
  } catch (err) {
    console.error("  ✗ Failed to create user_messages table:", err.message);
    // Don't throw - this is a migration, not critical for startup
  }
  
  // Ensure offer_messages table exists (legacy, kept for backwards compatibility)
  try {
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_name = 'offer_messages'
    `);
    if (tableCheck.rows.length === 0) {
      console.log("  Creating offer_messages table (legacy)...");
      await pool.query(`
        CREATE TABLE offer_messages (
          id SERIAL PRIMARY KEY,
          offer_id VARCHAR(255) NOT NULL,
          from_wallet VARCHAR(255) NOT NULL,
          to_wallet VARCHAR(255) NOT NULL,
          message TEXT NOT NULL CHECK (char_length(message) <= 2000),
          read_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`CREATE INDEX idx_offer_messages_offer_id ON offer_messages(offer_id)`);
      await pool.query(`CREATE INDEX idx_offer_messages_from_wallet ON offer_messages(from_wallet)`);
      await pool.query(`CREATE INDEX idx_offer_messages_to_wallet ON offer_messages(to_wallet)`);
      await pool.query(`CREATE INDEX idx_offer_messages_created_at ON offer_messages(created_at)`);
      await pool.query(`CREATE INDEX idx_offer_messages_conversation ON offer_messages(offer_id, from_wallet, to_wallet)`);
      await pool.query(`CREATE INDEX idx_offer_messages_from_to_created ON offer_messages(from_wallet, to_wallet, created_at)`);
      await pool.query(`CREATE INDEX idx_offer_messages_to_wallet_read_at ON offer_messages(to_wallet, read_at)`);
      console.log("  ✓ Created offer_messages table (legacy)");
    } else {
      console.log("  ⊙ offer_messages table already exists");
    }
  } catch (err) {
    console.error("  ✗ Failed to create offer_messages table:", err.message);
    // Don't throw - this is a migration, not critical for startup
  }

  // Admin/Arbiter: dispute_actions table and disputes.triggered_by_timeout
  try {
    const tableCheck = await pool.query(`
      SELECT table_name FROM information_schema.tables WHERE table_name = 'dispute_actions'
    `);
    if (tableCheck.rows.length === 0) {
      console.log("  Creating dispute_actions table...");
      await pool.query(`
        CREATE TABLE dispute_actions (
          id SERIAL PRIMARY KEY,
          offer_id VARCHAR(255) NOT NULL,
          action_type VARCHAR(30) NOT NULL CHECK (action_type IN ('request_info', 'under_review', 'resolved')),
          by_wallet VARCHAR(255) NOT NULL,
          payload JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query("CREATE INDEX idx_dispute_actions_offer_id ON dispute_actions(offer_id)");
      console.log("  ✓ Created dispute_actions table");
    } else {
      console.log("  ⊙ dispute_actions table already exists");
    }
  } catch (err) {
    console.error("  ✗ Failed to create dispute_actions table:", err.message);
  }
  try {
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'disputes' AND column_name = 'triggered_by_timeout'
    `);
    if (colCheck.rows.length === 0) {
      console.log("  Adding triggered_by_timeout to disputes...");
      await pool.query("ALTER TABLE disputes ADD COLUMN triggered_by_timeout BOOLEAN NOT NULL DEFAULT FALSE");
      console.log("  ✓ Added triggered_by_timeout");
    }
    if (!(await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'disputes' AND column_name = 'release_refund_tx_request_key'`)).rows.length) {
      console.log("  Adding release_refund_tx_request_key to disputes...");
      await pool.query("ALTER TABLE disputes ADD COLUMN release_refund_tx_request_key VARCHAR(255)");
      console.log("  ✓ Added release_refund_tx_request_key");
    }
    // Allow UNDER_REVIEW in status (drop old check, add new)
    await pool.query(`
      ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_status_check
    `).catch(() => {});
    await pool.query(`
      ALTER TABLE disputes ADD CONSTRAINT disputes_status_check
      CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'CLOSED'))
    `).catch((e) => {
      if (!e.message?.includes("already exists")) console.warn("  Note: disputes status constraint:", e.message);
    });
  } catch (err) {
    console.error("  ✗ Disputes migration:", err.message);
  }
  try {
    const fundTxCol = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'offer_details' AND column_name = 'fund_tx_request_key'
    `);
    if (fundTxCol.rows.length === 0) {
      console.log("  Adding fund_tx_request_key to offer_details...");
      await pool.query("ALTER TABLE offer_details ADD COLUMN fund_tx_request_key VARCHAR(255)");
      console.log("  ✓ Added fund_tx_request_key");
    }
  } catch (err) {
    console.error("  ✗ offer_details fund_tx_request_key migration:", err.message);
  }

  // Deliverable 5 — Database hardening: indexes and constraints (idempotent for existing DBs)
  try {
    await pool.query("CREATE INDEX IF NOT EXISTS idx_offer_details_creator_created_at ON offer_details(creator, created_at)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_user_messages_from_to_created ON user_messages(from_wallet, to_wallet, created_at)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_user_messages_to_wallet_read_at ON user_messages(to_wallet, read_at)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_offer_messages_from_to_created ON offer_messages(from_wallet, to_wallet, created_at)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_offer_messages_to_wallet_read_at ON offer_messages(to_wallet, read_at)");
    const addMsgConstraint = async (table, conname) => {
      const r = await pool.query(
        "SELECT 1 FROM pg_constraint WHERE conname = $1",
        [conname]
      );
      if (r.rows.length === 0) {
        await pool.query(
          `ALTER TABLE ${table} ADD CONSTRAINT ${conname} CHECK (char_length(message) <= 2000)`
        );
      }
    };
    await addMsgConstraint("user_messages", "chk_user_messages_message_len").catch(() => {});
    await addMsgConstraint("offer_messages", "chk_offer_messages_message_len").catch(() => {});
    await addMsgConstraint("dispute_messages", "chk_dispute_messages_message_len").catch(() => {});
    for (const table of ["user_messages", "offer_messages", "dispute_messages"]) {
      const col = await pool.query(
        "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'created_at'",
        [table]
      );
      if (col.rows.length > 0 && col.rows[0].is_nullable === "YES") {
        await pool.query(`UPDATE ${table} SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL`);
        await pool.query(`ALTER TABLE ${table} ALTER COLUMN created_at SET NOT NULL`);
      }
    }
    console.log("  ✓ Deliverable 5 DB indexes and constraints applied");
  } catch (err) {
    console.error("  ✗ Deliverable 5 migration (non-fatal):", err.message);
  }

  console.log("Database schema initialized successfully");
}

async function start() {
  try {
    // Parse connection string to extract database name
    const url = new URL(DATABASE_URL);
    const dbName = url.pathname.slice(1) || "kadena_nexus";
    
    // Connect to default 'postgres' database first to create our database if needed
    const adminUrl = DATABASE_URL.replace(`/${dbName}`, "/postgres");
    const adminPool = new Pool({ connectionString: adminUrl });
    
    try {
      // Check if database exists
      const result = await adminPool.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [dbName]
      );
      
      if (result.rows.length === 0) {
        // Database doesn't exist, create it
        console.log(`Creating database: ${dbName}`);
        await adminPool.query(`CREATE DATABASE ${dbName}`);
        console.log(`Database ${dbName} created successfully`);
      }
    } catch (createErr) {
      // If we can't create (might not have permissions), continue anyway
      console.warn("Could not create database automatically:", createErr.message);
      console.warn("Please create it manually: CREATE DATABASE " + dbName + ";");
    } finally {
      await adminPool.end();
    }
    
    // Now connect to our database
    pool = new Pool({
      connectionString: DATABASE_URL,
    });
    
    // Test connection
    await pool.query("SELECT 1");
    
    // Initialize schema
    console.log("Initializing database schema...");
    await initializeSchema();
    await initSessionSecret(pool);
    
    // Mask password in log output for security
    const safeUrl = DATABASE_URL.replace(/:[^:@]+@/, ":****@");
    console.log(`PostgreSQL connected: ${safeUrl}`);
  } catch (err) {
    console.error("PostgreSQL connection failed:");
    console.error("Error:", err.message || err);
    if (err.code) {
      console.error("Error code:", err.code);
    }
    console.error("\nPlease ensure:");
    console.error("1. PostgreSQL is running");
    console.error("2. User has permission to create databases (or create manually: CREATE DATABASE kadena_nexus;)");
    console.error("3. DATABASE_URL is correct");
    console.error("   - Format: postgresql://user:password@host:port/database");
    console.error("   - Current: " + DATABASE_URL.replace(/:[^:@]+@/, ":****@"));
    process.exit(1);
  }

  // HOST=127.0.0.1 keeps the API reachable only through nginx (the preview site uses it); unset = all interfaces, as before.
  httpServer.listen(PORT, process.env.HOST || undefined, () => {
    console.log(`Profile API listening on http://localhost:${PORT}`);
    startAlertWatcher(() => pool);
    startNotificationWatcher(() => pool);
    startTradeTxWatcher(() => pool, 15000, (x) => onTradeStepSettled(x));
    // v11 pools expire on the chain; the server only reminds the creator a day before
    startPoolExpiryWatcher(() => pool);
    startAutoReleaseWatcher(autoRelease);
    // once: drop rating registrations from before they were checked against the chain (kept in *_removed)
    setTimeout(() => recheckCompletedOffers(pool)
      .then((r) => { if (!r.skipped) console.log("[trust] rating registrations re-checked:", JSON.stringify(r)); })
      .catch((e) => console.warn("[trust] re-check postponed:", e.message)), 20000);
    console.log(`WebSocket server ready for online status tracking`);
  });
}

// Graceful shutdown
process.on("SIGINT", async () => {
  if (pool) {
    await pool.end();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (pool) {
    await pool.end();
  }
  process.exit(0);
});

start();
