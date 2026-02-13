import neo4j from 'neo4j-driver';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD),
  { disableLosslessIntegers: true }
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // Or your specific Lovable URL
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { Body, From, MessageSid, NumMedia, MediaUrl0 } = req.body;
  const session = driver.session();
  const cleanBody = (Body || "").trim().toLowerCase();

  try {
    // 1. Check if the user is answering the "Role" question
    const isDeclaringLandlord = cleanBody.includes("landlord") || cleanBody.includes("owner");
    const isDeclaringManager = cleanBody.includes("manager") || cleanBody.includes("caretaker");

    if (isDeclaringLandlord || isDeclaringManager) {
      const role = isDeclaringLandlord ? "Landlord" : "Property Manager";
      await session.executeWrite(tx =>
        tx.run('MERGE (p:Person { whatsapp: $sender }) SET p.role = $role', { sender: From, role })
      );

      return sendTwiML(res, `Got it, you are registered as a ${role}. Now, please send the address of the vacancy you want us to inspect.`);
    }

    // 2. Check if we already know this person's role
    const personResult = await session.run(
      'MATCH (p:Person {whatsapp: $sender}) RETURN p.role AS role',
      { sender: From }
    );
    const userRole = personResult.records[0]?.get('role');

    // 3. If no role is found, ask the question first
    if (!userRole) {
      return sendTwiML(res, "Welcome! To help us process your listing, are you the Landlord or the Property Manager?");
    }

    // 4. Role exists! Proceed with AI Extraction for the Property
    let aiExtracted = { address: null, phone: null };
    if (Body && Body.length > 5) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { 
            role: "system", 
            content: "Extract the property address and contact phone number. Return ONLY JSON: { \"address\": \"string\", \"phone\": \"string\" }." 
          },
          { role: "user", content: Body }
        ],
        response_format: { type: "json_object" }
      });
      aiExtracted = JSON.parse(completion.choices[0].message.content);
    }

    // 5. Save the Lead for the Field Agent
    const query = `
      MATCH (p:Person { whatsapp: $sender })
      MERGE (prop:Property { address: $address })
      ON CREATE SET 
        prop.status = 'Pending_Inspection',
        prop.verified = false
      
      CREATE (p)-[r:LISTED { id: $msgId }]->(prop)
      SET 
        r.originalText = $text,
        r.evidenceImage = $imageLink,
        r.createdAt = datetime(),
        r.roleAtTimeOfListing = p.role
        
      RETURN prop
    `;

    await session.executeWrite(tx =>
      tx.run(query, {
        sender: From,
        address: aiExtracted.address || "Unknown/Address Pending",
        phone: aiExtracted.phone || From,
        text: Body,
        imageLink: MediaUrl0 || null,
        msgId: MessageSid
      })
    );

    // 6. Final Response
    const responseMsg = aiExtracted.address 
      ? `Received! We've logged the vacancy at ${aiExtracted.address}. A field agent will contact you shortly for inspection and to verify bank details.`
      : "Thanks! We've received your message. Please ensure you've sent the full address so our field agent can schedule an inspection.";

    return sendTwiML(res, responseMsg);

  } catch (error) {
    console.error("Error:", error);
    return sendTwiML(res, "Message received! We're having a technical hiccup, but our team will review your message manually.");
  } finally {
    await session.close();
  }
}

// Helper function to keep code clean
function sendTwiML(res, message) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`
    <Response>
      <Message>${message}</Message>
    </Response>
  `);
}
