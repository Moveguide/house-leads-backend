import neo4j from 'neo4j-driver';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD),
  { disableLosslessIntegers: true }
);

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); 
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
    const isDeclaringLandlord = cleanBody.includes("landlord") || cleanBody.includes("owner");
    const isDeclaringManager = cleanBody.includes("manager") || cleanBody.includes("caretaker");

    if (isDeclaringLandlord || isDeclaringManager) {
      const role = isDeclaringLandlord ? "Landlord" : "Property Manager";
      await session.executeWrite(tx =>
        tx.run('MERGE (p:Person { whatsapp: $sender }) SET p.role = $role', { sender: From, role })
      );

      return sendTwiML(res, `Got it, you are registered as a ${role}. Now, please send the address of the vacancy you want us to inspect.`);
    }

    const personResult = await session.run(
      'MATCH (p:Person {whatsapp: $sender}) RETURN p.role AS role',
      { sender: From }
    );
    const userRole = personResult.records[0]?.get('role');

    if (!userRole) {
      return sendTwiML(res, "Welcome! To help us process your listing, are you the Landlord or the Property Manager?");
    }

    // --- AI EXTRACTION (EXTENDED FOR NIN/CAC & PREFERENCES) ---
    let aiExtracted = { address: null, landlord_name: null, agency_name: null, nin: null, cac: null, preferences: {}, reply: null };
    if (Body && Body.length > 5) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { 
            role: "system", 
            content: `You are a property intake assistant. Extract the following from the conversation:
            - address: Property location
            - landlord_name: Full name of owner
            - agency_name: Business/Agency name
            - nin: 11-digit National ID (Personal)
            - cac: Corporate Affairs Commission number (Business)
            - preferences: { "max_occupants": number, "employment": "string", "pets": "string", "marital_status": "string" }

            If info is missing, ask for ONE item politely (e.g., 'Could you please provide your NIN or CAC number for verification?').
            RETURN ONLY JSON: { "address", "landlord_name", "agency_name", "nin", "cac", "preferences", "reply" }` 
          },
          { role: "user", content: Body }
        ],
        response_format: { type: "json_object" }
      });
      aiExtracted = JSON.parse(completion.choices[0].message.content);
    }

    const finalAddress = aiExtracted.address || "Unknown/Address Pending";

    // 5. Save the Lead for the Field Agent (Neo4j)
    const query = `
      MATCH (p:Person { whatsapp: $sender })
      MERGE (prop:Property { address: $address })
      ON CREATE SET 
      prop.status = 'Pending_Inspection',
      prop.verified = false,
      prop.synced = false
      
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
        address: finalAddress,
        text: Body,
        imageLink: MediaUrl0 || null,
        msgId: MessageSid
      })
    );

    // --- MIRROR TO SUPABASE INSPECTIONS TABLE ---
    const cleanLandlordPhone = (From || "").replace('whatsapp:', '');

    const { error: supabaseError } = await supabase
    .from('inspections')
    .insert([
      { 
        address: finalAddress,
        landlord_phone: cleanLandlordPhone,
        landlord_name: aiExtracted.landlord_name || userRole,
        agency_name: aiExtracted.agency_name,
        nin_number: aiExtracted.nin,
        cac_number: aiExtracted.cac,
        landlord_preferences: aiExtracted.preferences,
        status: 'assigned', 
        user_id: null       
      }
    ]);

    if (supabaseError) console.error("Supabase Save Error:", supabaseError);
    // -------------------------------

    const responseMsg = aiExtracted.reply || (aiExtracted.address 
      ? `Received! We've logged the vacancy at ${aiExtracted.address}. A field agent will contact you shortly for inspection.`
      : "Thanks! We've received your message. Please ensure you've sent the full address so our field agent can schedule an inspection.");

    return sendTwiML(res, responseMsg);

  } catch (error) {
    console.error("Error:", error);
    return sendTwiML(res, "Message received! We're having a technical hiccup, but our team will review your message manually.");
  } finally {
    await session.close();
  }
}

function sendTwiML(res, message) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`
    <Response>
      <Message>${message}</Message>
    </Response>
  `);
}
