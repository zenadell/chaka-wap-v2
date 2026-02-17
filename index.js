const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcode = require('qrcode');
const fs = require('fs');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- AI STATE ---
let model = null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "YOUR_FALLBACK_KEY"; // Ideally fetch from Firebase

function initAI() {
    try {
        if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_FALLBACK_KEY") {
            console.log(">> AI Init Skipped (No Key)");
            return;
        }
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        model = genAI.getGenerativeModel({
            model: "gemini-pro",
            systemInstruction: "You are Temple, a witty and helpful AI assistant living in WhatsApp. Keep replies concise and engaging."
        });
        console.log(">> AI Initialized");
    } catch (e) {
        console.error(">> AI Init Failed:", e);
    }
}

async function generateResponse(prompt) {
    if (!model) return "I am currently offline (AI disabled).";
    try {
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (e) {
        console.error("AI Generation Error:", e);
        return "My brain hurts... try again later.";
    }
}

// --- 1. DNS & NETWORK FIX (THE ULTIMATE DO-OVER-HTTPS OPTION) ---
// UDP Port 53 is blocked in Docker. Resolving 'dns.google' via UDP fails.
// We hardcode 8.8.8.8 (Google DNS IP) which allows HTTPS DoH.
const dns = require('dns');
const https = require('https');

try {
    const originalLookup = dns.lookup;

    dns.lookup = (hostname, options, callback) => {
        // Argument polymorphism handling per Node.js docs
        if (typeof options === 'function') {
            callback = options;
            options = {};
        } else if (typeof options === 'number') {
            options = { family: options };
        } else if (!options) {
            options = {};
        }

        // Only override for web.whatsapp.com
        if (hostname === 'web.whatsapp.com') {
            console.log(`>> DNS DoH: Resolving ${hostname} via 8.8.8.8 HTTPS... (Options: ${JSON.stringify(options)})`);

            const req = https.get(`https://8.8.8.8/resolve?name=${hostname}&type=A`, {
                servername: 'dns.google'
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.Answer && json.Answer.length > 0) {
                            const ip = json.Answer.find(rec => rec.type === 1)?.data;
                            if (ip) {
                                console.log(`>> DNS DoH: Resolved ${hostname} -> ${ip}`);

                                // FORMAT RESPONSE BASED ON OPTIONS
                                if (options.all) {
                                    return callback(null, [{ address: ip, family: 4 }]);
                                } else {
                                    return callback(null, ip, 4);
                                }
                            }
                        }
                        // Fallback if no answer
                        console.error(">> DNS DoH: No Answer found, falling back.");
                        return originalLookup(hostname, options, callback);
                    } catch (e) {
                        console.error(">> DNS DoH Error parsing JSON:", e);
                        return originalLookup(hostname, options, callback);
                    }
                });
            });

            req.on('error', (e) => {
                console.error(">> DNS DoH Request Error:", e);
                return originalLookup(hostname, options, callback);
            });
            return;
        }

        return originalLookup(hostname, options, callback);
    };
    console.log(">> DNS: DoH Override Active (8.8.8.8 Direct + Options Support)");
} catch (e) {
    console.error(">> DNS Fix failed:", e);
}

// --- 2. SERVER SETUP ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

// --- CRITICAL CSP FIX ---
app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
        "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
        "connect-src * wss: ws:; " +
        "img-src * data: blob:;"
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
});

app.use(express.static('public'));
app.use(express.json());

// --- 3. FIREBASE INIT ---
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = require('./firebase-key.json');
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log(">> Firebase Connected");
} catch (e) {
    console.log(">> Running without Database (No Firebase Key found)");
}

// --- 4. WHATSAPP LOGIC (BAILEYS) ---
let sock;

async function connectToWhatsApp() {
    console.log(">> Initializing Baileys (Debug Mode)...");

    // Ensure auth folder exists
    if (!fs.existsSync('auth_info')) {
        fs.mkdirSync('auth_info');
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'debug' }),
        // browser: Baileys Default,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 250
    });

    initAI(); // Initialize AI on bot start


    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            // type === 'notify' means new message. 'append' means history sync.
            // We capture BOTH to build the "Digital Soul" database.

            for (const msg of messages) {
                if (!msg.message) continue;

                const jid = msg.key.remoteJid;
                const isMe = msg.key.fromMe;
                const senderName = msg.pushName || (isMe ? "Temple" : "Unknown");

                // Extract text (Handling different message types)
                const text = msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption || "";

                if (!text) continue; // Skip stickers/audio for now (Phase 3)

                // FIREBASE SAVE STRUCTURE
                // Collection: chats -> Doc: UserID -> Collection: messages -> Doc: MsgID
                if (db) {
                    const chatRef = db.collection('chats').doc(jid);

                    await chatRef.set({
                        lastActive: new Date(),
                        id: jid
                    }, { merge: true });

                    await chatRef.collection('messages').doc(msg.key.id).set({
                        text: text,
                        sender: isMe ? "Temple" : senderName,
                        fromMe: isMe,
                        timestamp: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000),
                        type: Object.keys(msg.message)[0]
                    });

                    console.log(`>> SAVED: ${senderName}: ${text.substring(0, 20)}...`);
                } else {
                    console.log(`>> (No DB) MSG: ${senderName}: ${text.substring(0, 20)}...`);
                }
            }
        } catch (e) {
            console.error("Save Error:", e);
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Log update keys for debugging
        console.log(`>> Connection Update Keys: ${Object.keys(update).join(', ')}`);

        if (qr) {
            console.log(">> QR GENERATED");
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    console.log(">> Sending QR to Frontend");
                    io.emit('qr', url);
                } else {
                    console.error(">> QR Error:", err);
                }
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('>> Connection Closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log(">> CONNECTED SUCCESSFULLLY");
            io.emit('ready', "System Online");
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- 5. API ENDPOINTS ---
app.post('/api/start-bot', (req, res) => {
    console.log(">> Start Bot requested");
    if (sock) {
        console.log(">> Bot already initialized");
        return res.json({ message: "Already running" });
    }
    connectToWhatsApp();
    res.json({ message: "Starting..." });
});

// --- NEW CRAWLER ENDPOINT ---
app.post('/api/crawl', async (req, res) => {
    if (!sock) return res.status(500).json({ error: "WhatsApp not connected" });
    console.log(">> STARTING FULL DATA SYNC (Passive Mode Active)...");
    res.json({ message: "Syncing started! Messages are being saved as they arrive." });
    // In passive mode, we just rely on the 'messages.upsert' listener we already added.
});

app.get('/api/check-key', (req, res) => res.json({ exists: true }));

const PORT = 7860;
server.listen(PORT, () => console.log(`>> Server running on port ${PORT}`));
