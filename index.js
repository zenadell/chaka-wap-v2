const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const dns = require('dns');

// --- DNS DIAGNOSTIC ---
console.log("--- SYSTEM NETWORK CHECK ---");
dns.lookup('web.whatsapp.com', (err, address) => {
    console.log(`DNS Lookup (web.whatsapp.com): ${err ? "FAILED - " + err.message : "SUCCESS - " + address}`);
});
dns.lookup('google.com', (err, address) => {
    console.log(`DNS Lookup (google.com): ${err ? "FAILED - " + err.message : "SUCCESS - " + address}`);
});

// --- CONFIGURATION ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- CSP MIDDLEWARE ---
app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:;"
    );
    next();
});

// Global State
let db;
let qrCodeUrl = null;
let isClientReady = false;
let geminiKey = process.env.GEMINI_API_KEY || null;
let whatsappClient = null;

// Initialize Firebase (Try Environment Secret first, then fallback to file)
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
} catch (error) {
    console.error("CRITICAL: Failed to initialize Firebase.");
}

app.use(express.static('public'));
app.use(express.json());

// --- API ENDPOINTS ---

// 1. Check if Key Exists
app.get('/api/check-key', async (req, res) => {
    if (geminiKey) return res.json({ exists: true });

    try {
        const doc = await db.collection('settings').doc('config').get();
        if (doc.exists) {
            const data = doc.data();
            const key = data.apiKey || data.geminiApiKey; // Check both names
            if (key) {
                geminiKey = key;
                return res.json({ exists: true });
            }
        }
    } catch (e) { console.error(e); }

    res.json({ exists: false });
});

// 2. Save Key
app.post('/api/save-key', async (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "No key provided" });

    try {
        // Save to both names to ensure future compatibility
        await db.collection('settings').doc('config').set({
            apiKey: key,
            geminiApiKey: key
        }, { merge: true });

        geminiKey = key;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Start WhatsApp Client (Triggered by Button)
app.post('/api/start-bot', (req, res) => {
    if (whatsappClient) return res.json({ message: "Already running" });

    startWhatsApp();
    res.json({ message: "Bot Initializing..." });
});

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    console.log('UI Connected');
    if (isClientReady) socket.emit('ready', 'Temple AI Connected Successfully');
    else if (qrCodeUrl) socket.emit('qr', qrCodeUrl);
});

// --- WHATSAPP LOGIC ---
function startWhatsApp() {
    console.log("Starting WhatsApp Client...");

    whatsappClient = new Client({
        authStrategy: new LocalAuth({ dataPath: '/app/auth_info' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--dns-server=8.8.8.8', // Docker Fix
                '--disable-ipv6'        // Docker Fix
            ],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
        }
    });

    whatsappClient.on('qr', (qr) => {
        console.log("QR Received");
        qrcode.toDataURL(qr, (err, url) => {
            qrCodeUrl = url;
            io.emit('qr', url);
        });
    });

    whatsappClient.on('ready', () => {
        console.log("WhatsApp Ready!");
        isClientReady = true;
        qrCodeUrl = null;
        io.emit('ready', "Temple AI Connected Successfully");
    });

    whatsappClient.on('message', async msg => {
        if (msg.fromMe) return;

        const contact = await msg.getContact();
        const chat = await msg.getChat();

        if (!geminiKey) {
            console.log("Skipping message: No API Key set");
            return;
        }

        const historySnapshot = await db.collection('chats').doc(contact.number).collection('messages')
            .orderBy('timestamp', 'desc').limit(10).get();

        let historyContext = "";
        historySnapshot.forEach(doc => {
            const data = doc.data();
            historyContext += `${data.sender}: ${data.text}\n`;
        });

        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `
        You are Temple. You are replying to a WhatsApp message.
        Here is your chat history with this person (${contact.pushname}):
        ${historyContext}
        
        Current Message: "${msg.body}"
        
        Instructions:
        - Mimic Temple's exact vibe from the history above.
        - If the history shows slang/pidgin, use it. If it's formal, be formal.
        - Keep it short and natural for WhatsApp.
        - Do not sound like an AI assistant.
        `;

        try {
            const result = await model.generateContent(prompt);
            const response = result.response.text();

            await chat.sendMessage(response);

            await db.collection('chats').doc(contact.number).collection('messages').add({
                text: msg.body,
                sender: contact.pushname,
                timestamp: new Date()
            });
            await db.collection('chats').doc(contact.number).collection('messages').add({
                text: response,
                sender: "Temple",
                timestamp: new Date()
            });

        } catch (error) {
            console.error("AI Error:", error);
        }
    });

    whatsappClient.initialize().catch(err => {
        console.error("CRITICAL ERROR: WhatsApp Client failed to initialize!");
        console.error(err);
    });
}

// --- THE CRAWLER ---
app.post('/api/crawl', async (req, res) => {
    if (!isClientReady || !whatsappClient) return res.status(400).send("WhatsApp not connected");

    res.send("Crawling started... check console/firebase.");

    const chats = await whatsappClient.getChats();

    for (const chat of chats) {
        console.log(`Scraping chat: ${chat.name}`);
        const messages = await chat.fetchMessages({ limit: 50 });
        const batch = db.batch();
        const chatRef = db.collection('chats').doc(chat.id.user);

        messages.forEach(msg => {
            const msgRef = chatRef.collection('messages').doc(msg.id.id);
            batch.set(msgRef, {
                text: msg.body,
                sender: msg.fromMe ? 'Temple' : (chat.name || 'User'),
                timestamp: new Date(msg.timestamp * 1000),
                type: msg.type
            });
        });

        await batch.commit();
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log("Crawling Complete");
});

// Start Server
const PORT = 7860;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
