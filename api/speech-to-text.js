import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const config = {
  api: {
    bodyParser: false, // Required for raw file upload
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const buffers = [];
    for await (const chunk of req) {
      buffers.push(chunk);
    }
    const audioBuffer = Buffer.concat(buffers);

    // Use the Node.js compatible method: pass buffer and filename
    const transcription = await openai.audio.transcriptions.create({
      file: audioBuffer,          // directly the buffer
      model: "whisper-1",
      filename: "audio.webm",     // filename required in Node
    });

    return res.status(200).json({
      transcript: transcription.text,
    });
  } catch (error) {
    console.error("Speech-to-text error:", error);
    return res.status(500).json({ error: "Transcription failed" });
  }
}
