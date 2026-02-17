const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcode = require('qrcode');
const fs = require('fs');
const admin = require('firebase-admin');

// --- 1. DNS & NETWORK FIX (THE NUCLEAR OPTION) ---
// The Docker container's system DNS is failing to resolve web.whatsapp.com.
// We override Node's internal DNS lookup to use Google's 8.8.8.8 explicitly.
const dns = require('dns');
try {
    // 1. Force use of Google DNS
    dns.setServers(['8.8.8.8', '8.8.4.4']);

    // 2. Override dns.lookup to use these servers (bypassing OS /etc/resolv.conf)
    const originalLookup = dns.lookup;
    dns.lookup = function (hostname, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        // Try our custom resolver first
        dns.resolve4(hostname, (err, addresses) => {
            if (!err && addresses && addresses.length > 0) {
                // Success! Return the first IPv4 address
                // console.log(`>> DNS FIX: Resolved ${hostname} -> ${addresses[0]}`);
                return callback(null, addresses[0], 4);
            }
            // Fallback to original system lookup if ours fails
            return originalLookup(hostname, options, callback);
        });
    };
    console.log(">> DNS: Active Override Enabled (Using 8.8.8.8)");
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
