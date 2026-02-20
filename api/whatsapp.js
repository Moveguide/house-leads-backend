import neo4j from 'neo4j-driver';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD), { disableLosslessIntegers: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { Body, From, MessageSid } = req.body;
  const cleanBody = (Body || "").trim();
  const sender = (From || "").replace('whatsapp:', '');
  const session = driver.session();

  try {
    // 1. Fetch current progress
    const { data: existing } = await supabase.from('inspections').select('*').eq('landlord_phone', sender).maybeSingle();

    // 2. The Interviewer Logic
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `You are a strict data collection bot. Check the database values and ask for the NEXT missing item.
          
          DATABASE VALUES:
          - Name: ${existing?.landlord_name || 'NULL'}
          - Address: ${existing?.address || 'NULL'}
          - NIN/CAC: ${existing?.nin_number || existing?.cac_number || 'NULL'}
          - Preferences: ${existing?.landlord_preferences ? 'SAVED' : 'NULL'}

          LOGIC RULES:
          1. If Name is NULL, extract name from user and ask for Address.
          2. If Name exists but Address is NULL, extract address and ask for NIN (11 digits) or CAC (starts with BN or RC).
          3. If Address exists but NIN/CAC is NULL, extract ID and ask for preferential requirements (pets, family, etc).
          4. If NIN/CAC exists, extract preferences and say "All set! An agent will call you."
          
          OUTPUT ONLY JSON: 
          { "landlord_name": "string", "address": "string", "nin": "string", "cac": "string", "preferences": {}, "reply": "string" }` 
        },
        { role: "user", content: cleanBody }
      ],
      response_format: { type: "json_object" }
    });

    const ai = JSON.parse(completion.choices[0].message.content);

    // 3. Prevent overwriting existing data with NULLs (The Loop Buster)
    const updateData = {
      landlord_phone: sender,
      landlord_name: ai.landlord_name || existing?.landlord_name,
      address: ai.address || existing?.address,
      nin_number: ai.nin || existing?.nin_number,
      cac_number: ai.cac || existing?.cac_number,
      landlord_preferences: (ai.preferences && Object.keys(ai.preferences).length > 0) ? ai.preferences : existing?.landlord_preferences,
      status: 'assigned'
    };

    // 4. Update Supabase
    await supabase.from('inspections').upsert(updateData, { onConflict: 'landlord_phone' });

    // 5. Update Neo4j if Address is newly found
    if (ai.address || existing?.address) {
      await session.executeWrite(tx => tx.run('MERGE (p:Person {whatsapp: $f}) MERGE (pr:Property {address: $a}) MERGE (p)-[:LISTED]->(pr)', { f: From, a: ai.address || existing.address }));
    }

    return sendTwiML(res, ai.reply);
  } catch (e) {
    return sendTwiML(res, "Got it. Please continue.");
  } finally {
    await session.close();
  }
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${msg}</Message></Response>`);
}
