const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcode = require('qrcode');
const fs = require('fs');
const admin = require('firebase-admin');

// --- 1. DNS & NETWORK FIX (CRITICAL FOR HUGGING FACE) ---
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // Forces IPv4 to avoid timeouts

// --- 2. SERVER SETUP ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Fix Content Security Policy (CSP) errors in frontend
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
});

app.use(express.static('public'));
app.use(express.json());

// --- 3. FIREBASE INIT ---
let db;
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("Firebase initialized from Environment Secret");
    } else {
        serviceAccount = require('./firebase-key.json');
        console.log("Firebase initialized from firebase-key.json file");
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log(">> Firebase Connected");
} catch (e) {
    console.log(">> Firebase Key not found (Running in memory mode)");
}

// --- 4. WHATSAPP LOGIC (BAILEYS) ---
let sock;

async function connectToWhatsApp() {
    console.log(">> Initializing Baileys...");
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Look for QR in logs too!
        logger: pino({ level: 'silent' }),
        browser: ["Temple AI", "Chrome", "1.0"],
        connectTimeoutMs: 60000, // Give it time to connect
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(">> QR CODE RECEIVED");
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) io.emit('qr', url);
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('>> Connection Closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('>> WHATSAPP CONNECTED SUCCESSFULLLY');
            io.emit('ready', "Temple AI Connected!");
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- 5. API ENDPOINTS ---
app.post('/api/start-bot', (req, res) => {
    connectToWhatsApp();
    res.json({ message: "Starting..." });
});

app.get('/api/check-key', (req, res) => res.json({ exists: true })); // Bypass for now

// Start Server
const PORT = 7860;
server.listen(PORT, () => console.log(`>> Server running on port ${PORT}`));
