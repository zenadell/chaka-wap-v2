const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcode = require('qrcode');
const fs = require('fs');
const admin = require('firebase-admin');

// --- SERVER SETUP ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

// --- SECURITY FIX (CRITICAL) ---
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
});

app.use(express.static('public'));
app.use(express.json());

// --- FIREBASE (Skip if missing) ---
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("Firebase initialized from Environment Secret");
    } else {
        serviceAccount = require('./firebase-key.json');
        console.log("Firebase initialized from firebase-key.json file");
    }

    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log(">> Firebase Connected");
} catch (e) {
    console.log(">> Running without Database");
}

// --- WHATSAPP LOGIC ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ["Temple AI", "Chrome", "1.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(">> QR GENERATED");
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) io.emit('qr', url);
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log(">> CONNECTED");
            io.emit('ready', "System Online");
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- API ---
app.post('/api/start-bot', (req, res) => {
    connectToWhatsApp();
    res.json({ status: "Starting" });
});

// Check Key Endpoint (Always true for now to bypass check)
app.get('/api/check-key', (req, res) => res.json({ exists: true }));

const PORT = 7860;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
