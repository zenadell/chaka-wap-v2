const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require("@google/generative-ai");
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

// Initialize Firebase (Try Environment Secret first, then fallback to file)
let serviceAccount;
try {
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
} catch (error) {
    console.error("CRITICAL: Failed to initialize Firebase.");
}
const db = admin.firestore();

// Initialize WhatsApp Client with Puppeteer settings for Docker
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    }
});

// --- STATE MANAGEMENT ---
let qrCodeUrl = '';
let isClientReady = false;
let geminiApiKey = process.env.GEMINI_API_KEY || '';

// --- WEB SERVER (The Admin Dashboard) ---
app.use(express.static('public'));
app.use(express.json());

// API Config Endpoints
app.get('/api/config', async (req, res) => {
    // Return masked key if exists
    res.json({ hasApiKey: !!geminiApiKey });
});

app.post('/api/config', async (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).send("API Key is required");

    geminiApiKey = apiKey;

    // Persist to Firestore
    await db.collection('settings').doc('config').set({ geminiApiKey: apiKey }, { merge: true });

    console.log("Updated Gemini API Key");
    res.send("API Key Updated");
});

// Load Config on Start
async function loadConfig() {
    try {
        const doc = await db.collection('settings').doc('config').get();
        if (doc.exists && doc.data().geminiApiKey) {
            geminiApiKey = doc.data().geminiApiKey;
            console.log("Loaded Gemini API Key from DB");
        } else {
            console.log("No Gemini API Key found in DB. Waiting for user input.");
        }
    } catch (e) {
        console.error("Failed to load config:", e);
    }
}
loadConfig();


// Socket.io for Real-time QR updates
io.on('connection', (socket) => {
    if (qrCodeUrl) socket.emit('qr', qrCodeUrl);
    if (isClientReady) socket.emit('ready', 'Connected to WhatsApp');
});

// --- WHATSAPP EVENTS ---
client.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
        qrCodeUrl = url;
        io.emit('qr', url);
    });
});

client.on('ready', () => {
    isClientReady = true;
    io.emit('ready', "System Connected. Temple AI is Online.");
    console.log('Client is ready!');
});

// --- THE AI MESSAGE HANDLER ---
client.on('message', async msg => {
    if (msg.fromMe) return; // Don't reply to yourself
    if (!geminiApiKey) {
        console.log("Skipping message: No API Key set");
        return;
    }

    const contact = await msg.getContact();
    const chat = await msg.getChat();

    // 1. Check if we should reply (You can add a toggle in DB for specific contacts)
    // For now, let's assume we reply to everyone or check a list

    // 2. RETRIEVE CONTEXT (The "Vibe" Check)
    // We fetch the last 10 messages from Firebase to see how YOU talk to THIS person
    const historySnapshot = await db.collection('chats').doc(contact.number).collection('messages')
        .orderBy('timestamp', 'desc').limit(10).get();

    let historyContext = "";
    historySnapshot.forEach(doc => {
        const data = doc.data();
        historyContext += `${data.sender}: ${data.text}\n`;
    });

    // 3. GENERATE RESPONSE
    const genAI = new GoogleGenerativeAI(geminiApiKey); // Initialize with dynamic key
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

        // 4. REPLY
        await chat.sendMessage(response);

        // 5. SAVE NEW LOG
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

// --- THE CRAWLER (Scrape Button Endpoint) ---
app.post('/api/crawl', async (req, res) => {
    if (!isClientReady) return res.status(400).send("WhatsApp not connected");

    res.send("Crawling started... check console/firebase.");

    const chats = await client.getChats();

    // Process chats one by one to avoid banning
    for (const chat of chats) {
        console.log(`Scraping chat: ${chat.name}`);

        // Fetch last 50 messages per chat
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
        await new Promise(r => setTimeout(r, 2000)); // Wait 2s between chats to be safe
    }

    console.log("Crawling Complete");
});

// Start Server
const PORT = 7860; // Hugging Face default port
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // Start WhatsApp Client
    console.log("Initializing WhatsApp Client...");
    client.initialize().catch(err => {
        console.error("CRITICAL ERROR: WhatsApp Client failed to initialize!");
        console.error(err);
    });
});
