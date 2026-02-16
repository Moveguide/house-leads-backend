import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const config = {
  api: {
    bodyParser: false, // Required for file uploads
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

    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], "audio.webm"),
      model: "whisper-1",
    });

    return res.status(200).json({
      transcript: transcription.text,
    });

  } catch (error) {
    console.error("Speech-to-text error:", error);
    return res.status(500).json({
      error: "Transcription failed",
    });
  }
}
