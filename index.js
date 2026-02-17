const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcode = require('qrcode');
const fs = require('fs');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- SETUP SERVER ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" } // Allow all connections
});

// Fix Security/CSP Issues
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
});

app.use(express.static('public'));
app.use(express.json());

// --- FIREBASE (Keep your existing logic) ---
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

    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log("Firebase Connected");
} catch (e) {
    console.log("Firebase Key not found (Running in no-db mode)");
}

// --- GLOBAL STATE ---
let sock;
let geminiKey = null;

// --- API ENDPOINTS ---
app.get('/api/check-key', async (req, res) => {
    if (geminiKey) return res.json({ exists: true });

    try {
        if (db) {
            const doc = await db.collection('settings').doc('config').get();
            if (doc.exists) {
                const data = doc.data();
                const key = data.apiKey || data.geminiApiKey;
                if (key) {
                    geminiKey = key;
                    return res.json({ exists: true });
                }
            }
        }
    } catch (e) { console.error(e); }

    res.json({ exists: false });
});

app.post('/api/save-key', async (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "No key provided" });

    try {
        if (db) {
            await db.collection('settings').doc('config').set({ apiKey: key, geminiApiKey: key }, { merge: true });
        }
        geminiKey = key;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/start-bot', async (req, res) => {
    await connectToWhatsApp();
    res.json({ message: "Starting..." });
});

// --- WHATSAPP CONNECTION (BAILEYS) ---
async function connectToWhatsApp() {
    // Saves session to 'auth_info' folder so you don't rescan every time
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Also prints to logs as backup
        logger: pino({ level: 'silent' }), // Hide messy logs
        browser: ["Temple AI", "Chrome", "1.0"]
    });

    // Handle Connection Events
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("QR CODE RECEIVED");
            // Convert QR string to Image Data URL for Frontend
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) io.emit('qr', url);
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting?', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                io.emit('ready', "Session Ended. Please Restart.");
            }
        } else if (connection === 'open') {
            console.log('OPENED CONNECTION');
            io.emit('ready', "Temple AI Connected!");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Listen for Messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        if (msg.key.fromMe) return;

        console.log('New Message:', JSON.stringify(msg.message));

        // AI AND CRAWLER LOGIC WILL BE RE-INTEGRATED HERE
        // For now, ensuring stable connection first.
    });
}

// --- START SERVER ---
const PORT = 7860;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
