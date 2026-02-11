import neo4j from 'neo4j-driver';

// 1. Improved Driver Config
// We move this inside or outside, but using bolt+s usually bypasses discovery issues
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD),
  {
    disableLosslessIntegers: true,
    maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 hours
    connectionTimeout: 30000, // 30 seconds
  }
);

export default async function handler(req, res) {
  // Only allow POST (Twilio)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  console.log("--- New WhatsApp Webhook Received ---");
  console.log("Connecting to:", process.env.NEO4J_URI);

  const { Body, From, MessageSid } = req.body;
  const session = driver.session();

  try {
    // 2. The Database Operation
    const query = `
      MERGE (l:Lead { messageId: $msgId })
      ON CREATE SET 
        l.text = $text,
        l.sender = $sender,
        l.status = 'New',
        l.createdAt = datetime()
      RETURN l
    `;

    const result = await session.executeWrite(tx => 
      tx.run(query, { 
        text: Body || "Empty Message", 
        sender: From || "Unknown", 
        msgId: MessageSid || `manual-${Date.now()}` 
      })
    );

    console.log("✅ Success: Lead saved to Neo4j");

    // 3. Twilio Response (TwiML)
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`
      <Response>
        <Message>Agent App: Lead recorded! 🏠 
Text: "${(Body || "").substring(0, 20)}..."</Message>
      </Response>
    `);

  } catch (error) {
    console.error("❌ Database Error Details:", error.message);
    
    // If it's specifically an Auth error, we'll see it clearly now
    if (error.message.includes("Unauthorized")) {
      console.error("CRITICAL: Check NEO4J_PASSWORD in Vercel Settings!");
    }

    return res.status(500).send('Error connecting to database');
  } finally {
    await session.close();
  }
}
