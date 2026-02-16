import OpenAI from "openai";
import { Readable } from "stream";
import FormData from "form-data";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const config = {
  api: { bodyParser: false }, // raw file upload
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    // Convert buffer to a Readable stream
    const stream = Readable.from(audioBuffer);

    // Create a FormData for multipart upload
    const form = new FormData();
    form.append("file", stream, { filename: "audio.webm" });
    form.append("model", "whisper-1");

    // Send to OpenAI transcription endpoint
    const transcription = await openai.audio.transcriptions.create({
      file: audioBuffer, // Node.js version accepts buffer directly with filename
      model: "whisper-1",
      filename: "audio.webm",
    });

    return res.status(200).json({ transcript: transcription.text });
  } catch (err) {
    console.error("Speech-to-text error:", err);
    return res.status(500).json({ error: "Transcription failed" });
  }
}
