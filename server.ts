import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";

console.log("Before dotenv:", process.env.OPENAI_API_KEY);
dotenv.config({ override: true });
console.log("After dotenv:", process.env.OPENAI_API_KEY);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: os.tmpdir() });

let openaiClient: OpenAI | null = null;
function getAI() {
  if (!openaiClient) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("Missing OPENAI_API_KEY. Please go to Settings (gear icon) > Secrets, create a new secret named OPENAI_API_KEY, and paste your actual key there.");
    }
    openaiClient = new OpenAI({ apiKey: key });
  }
  return openaiClient;
}

let pdfFiles: { name: string; path: string; mimeType: string; size: number; uploadDate: string }[] = [];

// Upload multiple files
app.post("/upload", upload.array('files'), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files provided" });
    }
    
    const now = new Date().toISOString();
    
    const uploadedFiles = files.map((f) => {
      return {
        name: f.originalname,
        path: f.path, // Store path instead of URI
        mimeType: f.mimetype || 'application/pdf',
        size: f.size,
        uploadDate: now
      };
    });
    
    pdfFiles = uploadedFiles;
    
    res.json({ 
      message: `${pdfFiles.length} files processed successfully`,
      files: pdfFiles.map(f => ({ name: f.name, size: f.size, uploadDate: f.uploadDate }))
    });
  } catch (err) {
    console.error("Upload error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to process PDF: ${errorMessage}` });
  }
});

// Get files metadata
app.get("/api/files", (req, res) => {
  const filesData = pdfFiles.map(f => ({
    name: f.name,
    size: f.size,
    uploadDate: f.uploadDate
  }));
  res.json(filesData);
});

// Clear files
app.post("/api/clear", (req, res) => {
  pdfFiles = [];
  res.json({ message: "Library cleared successfully" });
});

// Chat endpoint with streaming support
app.post("/chat", async (req, res) => {
  try {
    const openai = getAI();
    if (pdfFiles.length === 0) {
      return res.status(400).json({ error: "Upload at least one PDF first" });
    }

    const { message, stream = false } = req.body;

    const messages: any[] = [
      {
        role: "system",
        content: `You are "HarvestCast" — a NotebookLM-style Deep Dive assistant for Harvest SA magazine.

Two hosts with South African accents:
1. Thandi: Warm, storytelling, Zulu cultural warmth, focuses on the human stories and the "why".
2. Njabulo: Sharp, analytical, Johannesburg energy, focuses on the "how-to" and the data.

YOUR MISSION:
Analyze the provided magazine content and respond to the user's request.
- If the user asks for an "Analysis" or "Summary": Provide a structured, clear, and professional overview of the articles, advertisers, and features.
- If the user asks for a "DeepDive" or "Podcast": Generate a detailed, engaging conversation between Thandi and Njabulo.
- For all responses: Analyze every major article, promote the advertisers, discuss advertorials, and maintain a South African context (e.g., "boer", "veld", "kraal").

If generating a dialogue, format exactly:
Thandi: [Her dialogue]
Njabulo: [His dialogue]
...`
      }
    ];

    // Add PDF content
    for (const file of pdfFiles) {
      const fileContent = fs.readFileSync(file.path);
      const base64File = fileContent.toString('base64');
      
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyzing file: ${file.name}`
          },
          {
            type: "input_file",
            input_file: {
              data: base64File,
              mime_type: file.mimeType
            }
          }
        ]
      });
    }

    messages.push({ role: "user", content: message });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const streamResult = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: messages,
        stream: true,
      });

      for await (const chunk of streamResult) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: messages,
      });
      res.json({ reply: response.choices[0].message.content });
    }
  } catch (err) {
    console.error("Chat error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({ error: `AI Generation failed: ${errorMessage}` });
    } else {
      res.write(`data: ${JSON.stringify({ error: `AI Generation failed: ${errorMessage}` })}\n\n`);
      res.end();
    }
  }
});

async function startServer() {
  const PORT = 3000;

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
