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

    // --- 1. FETCH CONTEXT FROM SUPABASE ---
    const cleanLandlordPhone = (From || "").replace('whatsapp:', '');
    const { data: existingLead } = await supabase
      .from('inspections')
      .select('*')
      .eq('landlord_phone', cleanLandlordPhone)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // --- 2. AI EXTRACTION WITH MEMORY ---
    let aiExtracted = { address: null, landlord_name: null, agency_name: null, nin: null, cac: null, preferences: {}, reply: null };
    if (Body && Body.length > 0) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { 
            role: "system", 
            content: `You are a property intake assistant. 
            WE ALREADY KNOW THIS ABOUT THE USER:
            - Address: ${existingLead?.address || 'Unknown'}
            - Landlord Name: ${existingLead?.landlord_name || 'Unknown'}
            - NIN: ${existingLead?.nin_number || 'Unknown'}
            - CAC: ${existingLead?.cac_number || 'Unknown'}

            YOUR TASK:
            1. Extract any NEW info from the message.
            2. If any core info (Address, Name, or an ID like NIN/CAC) is 'Unknown', politely ask for ONE of them.
            3. If core info is complete, ask about preferences (pets, occupants, marital status).
            4. Keep it natural and conversational. Ask ONLY ONE question at a time.
            RETURN ONLY JSON: { "address", "landlord_name", "agency_name", "nin", "cac", "preferences", "reply" }` 
          },
          { role: "user", content: Body }
        ],
        response_format: { type: "json_object" }
      });
      aiExtracted = JSON.parse(completion.choices[0].message.content);
    }

    const finalAddress = aiExtracted.address || existingLead?.address || "Unknown/Address Pending";

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

    // --- 3. MIRROR TO SUPABASE (UPSERT MODE) ---
    const { error: supabaseError } = await supabase
    .from('inspections')
    .upsert({ 
        landlord_phone: cleanLandlordPhone,
        address: finalAddress,
        landlord_name: aiExtracted.landlord_name || existingLead?.landlord_name || userRole,
        agency_name: aiExtracted.agency_name || existingLead?.agency_name,
        nin_number: aiExtracted.nin || existingLead?.nin_number,
        cac_number: aiExtracted.cac || existingLead?.cac_number,
        landlord_preferences: { ...existingLead?.landlord_preferences, ...aiExtracted.preferences },
        status: 'assigned', 
        user_id: null       
    }, { onConflict: 'landlord_phone' });

    if (supabaseError) console.error("Supabase Save Error:", supabaseError);
    // -------------------------------

    const responseMsg = aiExtracted.reply || "Thanks! We've received your message and are processing the details.";

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
