import neo4j from 'neo4j-driver';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD),
  { disableLosslessIntegers: true }
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { Body, From, MessageSid, MediaUrl0 } = req.body;
  const session = driver.session();
  const cleanBody = (Body || "").trim();
  const cleanLandlordPhone = (From || "").replace('whatsapp:', '');

  try {
    // 1. CHECK REGISTRATION ROLE
    const personResult = await session.run(
      'MATCH (p:Person {whatsapp: $sender}) RETURN p.role AS role',
      { sender: From }
    );
    let userRole = personResult.records[0]?.get('role');

    if (!userRole) {
      const lowerBody = cleanBody.toLowerCase();
      if (lowerBody.includes("landlord") || lowerBody.includes("manager") || lowerBody.includes("owner")) {
        userRole = lowerBody.includes("landlord") || lowerBody.includes("owner") ? "Landlord" : "Property Manager";
        await session.executeWrite(tx =>
          tx.run('MERGE (p:Person { whatsapp: $sender }) SET p.role = $role', { sender: From, role: userRole })
        );
        return sendTwiML(res, `Great. You are registered as ${userRole}. What is your full name?`);
      }
      return sendTwiML(res, "Welcome! To help us process your listing, are you the Landlord or the Property Manager?");
    }

    // 2. FETCH EXISTING PROGRESS FROM SUPABASE
    const { data: existing } = await supabase
      .from('inspections')
      .select('*')
      .eq('landlord_phone', cleanLandlordPhone)
      .maybeSingle();

    // 3. AI LOGIC WITH RIGID CHECKLIST
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `You are a property intake assistant. You must collect info in this EXACT order. 
          
          CURRENT STATUS:
          1. Name: ${existing?.landlord_name || 'MISSING'}
          2. Address: ${existing?.address || 'MISSING'}
          3. ID (NIN/CAC): ${ (existing?.nin_number || existing?.cac_number) ? 'RECEIVED' : 'MISSING'}
          4. Preferences: ${ (existing?.landlord_preferences && Object.keys(existing.landlord_preferences).length > 0) ? 'RECEIVED' : 'MISSING'}

          RULES:
          - If Name is MISSING, ask for Name.
          - If Name is present but Address is MISSING, ask for Address.
          - If Address is present but ID is MISSING, ask for NIN (11 digits) or CAC (starts with BN or RC).
          - If ID is present but Preferences are MISSING, ask if they have specific requirements (pets, marital status, number of occupants).
          - If ALL 4 are present, say "Thank you! All details are logged. An agent will contact you shortly." and set 'complete' to true.

          RETURN ONLY JSON: { "landlord_name", "address", "nin", "cac", "preferences", "reply", "complete" }` 
        },
        { role: "user", content: cleanBody }
      ],
      response_format: { type: "json_object" }
    });

    const ai = JSON.parse(completion.choices[0].message.content);

    // 4. UPDATE SUPABASE (UPSERT)
    await supabase.from('inspections').upsert({
      landlord_phone: cleanLandlordPhone,
      landlord_name: ai.landlord_name || existing?.landlord_name || userRole,
      address: ai.address || existing?.address,
      nin_number: ai.nin || existing?.nin_number,
      cac_number: ai.cac || existing?.cac_number,
      landlord_preferences: ai.preferences && Object.keys(ai.preferences).length > 0 ? ai.preferences : existing?.landlord_preferences,
      status: 'assigned'
    }, { onConflict: 'landlord_phone' });

    // 5. UPDATE NEO4J (KEEPING YOUR ORIGINAL LOGIC)
    if (ai.address) {
      await session.executeWrite(tx =>
        tx.run(`
          MATCH (p:Person { whatsapp: $sender })
          MERGE (prop:Property { address: $address })
          CREATE (p)-[r:LISTED { id: $msgId }]->(prop)
          SET r.createdAt = datetime()`, 
        { sender: From, address: ai.address, msgId: MessageSid })
      );
    }

    return sendTwiML(res, ai.reply);

  } catch (error) {
    console.error("Error:", error);
    return sendTwiML(res, "We've received your message and will update your record manually.");
  } finally {
    await session.close();
  }
}

function sendTwiML(res, message) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${message}</Message></Response>`);
}
