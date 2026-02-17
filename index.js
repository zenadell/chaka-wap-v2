const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcode = require('qrcode');
const fs = require('fs');
const admin = require('firebase-admin');

// --- 1. DNS & NETWORK FIX (THE ULTIMATE DO-OVER-HTTPS OPTION) ---
// UDP Port 53 seems blocked or broken. We will use DNS-over-HTTPS (DoH).
// This uses standard HTTPS (443) which is guaranteed to work.
const dns = require('dns');
const https = require('https');

try {
    const originalLookup = dns.lookup;

    dns.lookup = (hostname, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        // Only override for web.whatsapp.com to be safe, or local lookups
        if (hostname === 'web.whatsapp.com') {
            console.log(`>> DNS DoH: Resolving ${hostname} via Google HTTPS...`);

            const req = https.get(`https://dns.google/resolve?name=${hostname}&type=A`, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.Answer && json.Answer.length > 0) {
                            const ip = json.Answer.find(rec => rec.type === 1)?.data; // Type 1 is A record
                            if (ip) {
                                console.log(`>> DNS DoH: Resolved ${hostname} -> ${ip}`);
                                return callback(null, ip, 4);
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

        // Default behavior for everything else
        return originalLookup(hostname, options, callback);
    };
    console.log(">> DNS: DoH Override Active (web.whatsapp.com only)");
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
// We explicitly set script-src to allow eval, and connect-src to allow WSS
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
        printQRInTerminal: true,
        // ENABLE DEBUG LOGS to see why it hangs
        logger: pino({ level: 'debug' }),
        browser: ["Temple AI", "Chrome", "1.0"],
        connectTimeoutMs: 60000,
        // Fix for some network environments
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 250
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Log everything for debugging
        console.log(`>> Connection Update: ${JSON.stringify(update)}`);

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

app.get('/api/check-key', (req, res) => res.json({ exists: true }));

const PORT = 7860;
server.listen(PORT, () => console.log(`>> Server running on port ${PORT}`));
