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
    // 1. DATABASE CHECK (The Truth)
    const { data: records } = await supabase.from('inspections').select('*').eq('landlord_phone', senderPhone);
    const latest = records?.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || {};
    
    // Check global status
    const hasName = records?.some(r => r.landlord_name && r.landlord_name.length > 2);
    const hasAddress = latest.address && latest.address !== "Pending";
    const hasID = records?.some(r => r.nin_number || r.cac_number);
    const hasPrefs = latest.landlord_preferences && Object.keys(latest.landlord_preferences).length > 0;

    // 2. HARDCODED STEP LOGIC
    let currentGoal = "NAME";
    if (hasName) currentGoal = "ADDRESS";
    if (hasName && hasAddress) currentGoal = "ID";
    if (hasName && hasAddress && hasID) currentGoal = "PREFERENCES";
    if (hasName && hasAddress && hasID && hasPrefs) currentGoal = "COMPLETE";

    // 3. AI ONLY EXTRACTS THE GOAL
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `You are a property assistant. Your ONLY job is to help the user with the current step: ${currentGoal}.
          
          SEQUENCE: Name -> Address -> ID (NIN/CAC) -> Preferences.
          
          If the user provides the ${currentGoal}, acknowledge it and ask for the NEXT step in the sequence. 
          If they provide something else, politely ask them for the ${currentGoal}.
          - NIN: 11 digits.
          - CAC: Starts with BN or RC.
          - Prefs: Pets, family size, etc.

          RETURN ONLY JSON: { "extracted_val": "string", "reply": "string" }` 
        },
        { role: "user", content: cleanBody }
      ],
      response_format: { type: "json_object" }
    });

    const ai = JSON.parse(completion.choices[0].message.content);

    // 4. THE SAVING LOGIC (The Code controls where data goes, not the AI)
    const updateData = {
      landlord_phone: senderPhone,
      landlord_name: currentGoal === "NAME" ? ai.extracted_val : (records?.find(r => r.landlord_name)?.landlord_name || "Unknown"),
      address: currentGoal === "ADDRESS" ? ai.extracted_val : (latest.address || "Pending"),
      nin_number: (currentGoal === "ID" && ai.extracted_val?.length === 11) ? ai.extracted_val : (records?.find(r => r.nin_number)?.nin_number || null),
      cac_number: (currentGoal === "ID" && (ai.extracted_val?.startsWith('BN') || ai.extracted_val?.startsWith('RC'))) ? ai.extracted_val : (records?.find(r => r.cac_number)?.cac_number || null),
      landlord_preferences: currentGoal === "PREFERENCES" ? { details: ai.extracted_val } : (latest.landlord_preferences || {}),
      status: 'assigned'
    };

    // 5. UPSERT
    await supabase.from('inspections').upsert(updateData, { onConflict: 'landlord_phone, address' });

    return sendTwiML(res, ai.reply);

  } catch (e) {
    return sendTwiML(res, "I've noted that. What's the next detail?");
  }
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${msg}</Message></Response>`);
}
