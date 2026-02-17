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
        browser: ["Ubuntu", "Chrome", "20.0.04"], // Explicitly set standard browser
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 250
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

app.get('/api/check-key', (req, res) => res.json({ exists: true }));

const PORT = 7860;
server.listen(PORT, () => console.log(`>> Server running on port ${PORT}`));
