import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';

const router = express.Router();
const upload = multer(); // For handling file uploads

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// POST /api/speech-to-text
router.post('/', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const transcription = await openai.audio.transcriptions.create({
      file: req.file.buffer,
      model: 'whisper-1',
    });

    res.json({ transcript: transcription.text });
  } catch (err: any) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: err.message || 'Transcription failed' });
  }
});

export default router;
