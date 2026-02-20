import neo4j from 'neo4j-driver';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD), { disableLosslessIntegers: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { Body, From } = req.body;
  const cleanBody = (Body || "").trim();
  const senderPhone = (From || "").replace('whatsapp:', '');

  try {
    // 1. FETCH DATA - Use .eq() correctly
    const { data: existing } = await supabase
      .from('inspections')
      .select('*')
      .eq('landlord_phone', senderPhone)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // 2. DETERMINE THE CURRENT STEP (Force the AI to see the checklist)
    const nameStatus = existing?.landlord_name ? "COMPLETED" : "MISSING";
    const addressStatus = existing?.address && existing.address !== "Pending" ? "COMPLETED" : "MISSING";
    const idStatus = (existing?.nin_number || existing?.cac_number) ? "COMPLETED" : "MISSING";
    const prefStatus = (existing?.landlord_preferences && Object.keys(existing.landlord_preferences).length > 0) ? "COMPLETED" : "MISSING";

    // 3. AI INTERVIEWER
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `You are a real estate assistant. Follow this checklist STRICTLY:
          1. NAME: ${nameStatus} (Value: ${existing?.landlord_name || 'None'})
          2. ADDRESS: ${addressStatus} (Value: ${existing?.address || 'None'})
          3. ID (NIN/CAC): ${idStatus}
          4. PREFERENCES: ${prefStatus}

          DIRECTIONS:
          - If a step is MISSING, extract that info from the user's message.
          - If the user provides info for a MISSING step, move to the NEXT missing step in your 'reply'.
          - NEVER ask for info that is already COMPLETED.
          - NIN must be 11 digits. CAC must start with BN or RC.
          
          RETURN ONLY JSON: { "landlord_name", "address", "nin", "cac", "preferences", "reply" }` 
        },
        { role: "user", content: cleanBody }
      ],
      response_format: { type: "json_object" }
    });

    const ai = JSON.parse(completion.choices[0].message.content);

    // 4. SMART MERGE (This prevents the loop by keeping existing data if AI misses it)
    const updateData = {
      landlord_phone: senderPhone,
      landlord_name: ai.landlord_name || existing?.landlord_name,
      address: ai.address || existing?.address || "Pending",
      nin_number: ai.nin || existing?.nin_number,
      cac_number: ai.cac || existing?.cac_number,
      landlord_preferences: (ai.preferences && Object.keys(ai.preferences).length > 0) ? ai.preferences : existing?.landlord_preferences,
      status: 'assigned'
    };

    // 5. UPSERT
    await supabase.from('inspections').upsert(updateData, { onConflict: 'landlord_phone, address' });

    return sendTwiML(res, ai.reply);

  } catch (e) {
    console.error(e);
    return sendTwiML(res, "Got that. Please provide the next detail (Name, Address, ID, or Preferences).");
  }
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${msg}</Message></Response>`);
}
