import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function run() {
  fs.writeFileSync("test.txt", "Hello world");
  const uploadResult = await ai.files.upload({ file: "test.txt", mimeType: "text/plain" });
  console.log(uploadResult.name, uploadResult.uri);
}
run().catch(console.error);
