import neo4j from 'neo4j-driver';
import OpenAI from 'openai';

// Initialize AI and Database
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD),
  { disableLosslessIntegers: true }
);

export default async function handler(req, res) {
  // 1. Safety Check: Only allow POST (Twilio)
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const { Body, From, MessageSid, NumMedia, MediaUrl0 } = req.body;
  const session = driver.session();

  try {
    let aiExtracted = { address: null, phone: null };
    let isImage = parseInt(NumMedia) > 0;

    // 2. If it's text, extract details using AI
    if (Body && Body.length > 5) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { 
            role: "system", 
            content: "Extract the property address and contact phone number from this message. Return ONLY JSON: { \"address\": \"string\", \"phone\": \"string\" }. If information is missing, use null." 
          },
          { role: "user", content: Body }
        ],
        response_format: { type: "json_object" }
      });
      aiExtracted = JSON.parse(completion.choices[0].message.content);
    }

    // 3. Database Operation: Graph Linking
    // We link the Person to the Property and store the NIN/Utility bill image if provided
    const query = `
      MERGE (p:Person { whatsapp: $sender })
      
      // We use the extracted address as the unique ID for the property
      MERGE (prop:Property { address: $address })
      ON CREATE SET 
        prop.extractedPhone = $phone,
        prop.verified = false,
        prop.status = 'Pending'

      // Create the relationship (The Lead)
      CREATE (p)-[r:LISTED { id: $msgId }]->(prop)
      SET 
        r.originalText = $text,
        r.evidenceImage = $imageLink,
        r.createdAt = datetime(),
        r.hasMedia = $hasMedia
        
      RETURN p, prop
    `;

    await session.executeWrite(tx => 
      tx.run(query, { 
        sender: From, 
        address: aiExtracted.address || "Unknown/Pending", 
        phone: aiExtracted.phone || From,
        text: Body || "",
        imageLink: MediaUrl0 || null,
        msgId: MessageSid,
        hasMedia: isImage
      })
    );

    // 4. Smart Response Logic
    let responseMessage = "";
    if (isImage) {
      responseMessage = "Thank you for the document! Our agents will verify your NIN/Utility bill and update your listing status shortly.";
    } else if (aiExtracted.address) {
      responseMessage = `Got it! To list "${aiExtracted.address}", please reply with a photo of your NIN or Utility Bill for verification.`;
    } else {
      responseMessage = "Thanks for reaching out! Please send the property address and a photo of your NIN to get started.";
    }

    // 5. Send TwiML response back to Twilio
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`
      <Response>
        <Message>${responseMessage}</Message>
      </Response>
    `);

  } catch (error) {
    console.error("Critical Error:", error);
    // Fallback response so the user isn't left hanging
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`
      <Response>
        <Message>Message received! Our system is a bit busy, but an agent will review your request manually soon.</Message>
      </Response>
    `);
  } finally {
    await session.close();
  }
}
