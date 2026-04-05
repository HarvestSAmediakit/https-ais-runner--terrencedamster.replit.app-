const BACKEND = "https://ais-runner--terrencedamster.replit.app";

// 1. Upload a PDF
export async function uploadPDF(file: File) {
  const formData = new FormData();
  formData.append("files", file); // Changed to "files" to match server
  const res = await fetch(`${BACKEND}/upload`, {
    method: "POST",
    body: formData
  });
  return res.json(); // { sessionId, filename, pageCount, wordCount }
}

// 2. Generate podcast episode
export async function generateEpisode(sessionId: string, topic = "") {
  const res = await fetch(`${BACKEND}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: topic, stream: false })
  });
  return res.json(); // { reply }
}

// 3. Text to speech for one line
export async function textToSpeech(text: string, speaker: string) {
  // This part needs to be implemented on the backend as well
  const res = await fetch(`${BACKEND}/api/harvest/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, speaker }) // "Thandi" or "Njabulo"
  });
  const { audioBase64 } = await res.json();
  // Play it:
  const audio = new Audio(`data:audio/mp3;base64,${audioBase64}`);
  audio.play();
}
