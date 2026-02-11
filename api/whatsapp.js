import neo4j from 'neo4j-driver';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD)
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const { Body, From, MessageSid } = req.body;

  try {
    // 1. Ask AI to extract the data
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Fast and cheap for extraction
      messages: [
        { role: "system", content: "Extract property address and contact number from the message. Return ONLY JSON: { \"address\": \"string\", \"phone\": \"string\" }. If missing, use null." },
        { role: "user", content: Body }
      ],
      response_format: { type: "json_object" }
    });

    const extracted = JSON.parse(completion.choices[0].message.content);

    // 2. Save to Neo4j with the NEW extracted fields
    const session = driver.session();
    await session.executeWrite(tx => 
      tx.run(`
        MERGE (l:Lead { messageId: $msgId })
        ON CREATE SET 
          l.originalText = $text,
          l.extractedAddress = $address,
          l.extractedPhone = $phone,
          l.senderWhatsApp = $sender,
          l.status = 'Unverified',
          l.createdAt = datetime()
      `, { 
        msgId: MessageSid, 
        text: Body, 
        address: extracted.address, 
        phone: extracted.phone, 
        sender: From 
      })
    );
    await session.close();

    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(`<Response><Message>AI extracted: ${extracted.address || 'Address pending'}. We will verify shortly!</Message></Response>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
}
