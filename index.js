const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- CONFIGURATION ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- FIX 1: SECURITY HEADERS (Solves "Content Security Policy" Error) ---
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
});

app.use(express.static('public'));
app.use(express.json());

// Initialize Firebase
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
    console.log("Firebase Initialized");
} catch (e) {
    console.error("Firebase Key Missing! Upload firebase-key.json or set FIREBASE_SERVICE_ACCOUNT env var.");
}

// Global State
let qrCodeUrl = null;
let isClientReady = false;
let geminiKey = null;
let whatsappClient = null;

// --- API ENDPOINTS ---
app.get('/api/check-key', async (req, res) => {
    if (geminiKey) return res.json({ exists: true });
    try {
        const doc = await db.collection('settings').doc('config').get();
        if (doc.exists) {
            const data = doc.data();
            const key = data.apiKey || data.geminiApiKey;
            if (key) {
                geminiKey = key;
                return res.json({ exists: true });
            }
        }
    } catch (e) { console.error(e); }
    res.json({ exists: false });
});

app.post('/api/save-key', async (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "No key provided" });
    try {
        await db.collection('settings').doc('config').set({ apiKey: key, geminiApiKey: key }, { merge: true });
        geminiKey = key;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/start-bot', (req, res) => {
    if (whatsappClient) return res.json({ message: "Already running" });
    startWhatsApp();
    res.json({ message: "Bot Initializing..." });
});

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    console.log('UI Connected');
    if (isClientReady) socket.emit('ready', 'System Online');
    else if (qrCodeUrl) socket.emit('qr', qrCodeUrl);
});

// --- WHATSAPP LOGIC ---
function startWhatsApp() {
    console.log("Starting WhatsApp Client...");

    // --- FIX 2: INTERNET CONNECTION (Solves "DNS Lookup Failed") ---
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
                '--ignore-certificate-errors',
                '--dns-server=8.8.8.8', // <--- CRITICAL: Forces Google DNS
                '--disable-ipv6'
            ],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
        }
    });

    whatsappClient.on('qr', (qr) => {
        console.log("QR RECEIVED FROM WHATSAPP"); // Watch for this in logs
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

    // Message Logic
    whatsappClient.on('message', async msg => {
        if (msg.fromMe) return;

        if (!geminiKey) return;

        const contact = await msg.getContact();
        const chat = await msg.getChat();

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
        console.error("CRITICAL INIT ERROR:", err);
    });
}

// Start Server
const PORT = 7860;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
