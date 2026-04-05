import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function run() {
  fs.writeFileSync("test2.txt", "Hello world");
  try {
    const uploadResult = await ai.files.upload({ file: "test2.txt", config: { mimeType: "text/plain" } });
    console.log(uploadResult.name, uploadResult.uri);
  } catch (e) {
    console.error(e);
  }
}
run();
