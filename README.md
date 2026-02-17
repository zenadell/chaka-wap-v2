# Chaka Wap V2

A "Digital Twin" WhatsApp bot using `whatsapp-web.js`, Google Gemini 1.5, and Firebase Firestore.
Designed to be hosted on Hugging Face Spaces using Docker.

## Features
- **Personality Mimicry**: Uses RAG to mimic your tone from past messages.
- **Data Crawling**: Scrapes chat history to Firebase for long-term memory.
- **Dynamic Configuration**: Manage API Keys via the Admin Dashboard.
- **Dockerized**: specific `Dockerfile` for Hugging Face compatibility (Chrome/Puppeteer).
