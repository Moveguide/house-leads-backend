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
    // 1. FETCH DATA
    const { data: records } = await supabase
      .from('inspections')
      .select('*')
      .eq('landlord_phone', senderPhone);
    
    // FIX: Better filtering to ensure we don't pick up "Pending" as a real value
    const knownName = records?.find(r => r.landlord_name && !["COMPLETED", "Pending", "Unknown"].includes(r.landlord_name))?.landlord_name;
    const knownIDRecord = records?.find(r => r.nin_number || r.cac_number);
    const latestListing = records?.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || {};

    // 2. LOGIC: The Goalposts
    let currentGoal = "NAME";
    if (knownName) currentGoal = "ADDRESS";
    if (knownName && latestListing.address && !["Pending", "Unknown"].includes(latestListing.address)) currentGoal = "ID";
    if (knownName && latestListing.address && (knownIDRecord?.nin_number || knownIDRecord?.cac_number)) currentGoal = "PREFERENCES";

    // 3. AI EXTRACTION
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `You are an extractor. The user is providing their ${currentGoal}.
          - Extract the value. 
          - NIN: 11 digits. CAC: Starts with BN or RC.
          - Write a reply asking for the NEXT step: Name -> Address -> ID -> Preferences.
          RETURN ONLY JSON: { "extracted_value": "string", "reply": "string" }` 
        },
        { role: "user", content: cleanBody }
      ],
      response_format: { type: "json_object" }
    });

    const ai = JSON.parse(completion.choices[0].message.content);
    const newVal = ai.extracted_value;

    // 4. SMART DATA MAPPING (The Loop Killer)
    // We only create a payload for the specific field we are updating.
    // This prevents "NULLing" out your inspection columns.
    let updateData = {
      landlord_phone: senderPhone,
      status: 'assigned'
    };

    if (currentGoal === "NAME") updateData.landlord_name = newVal;
    if (currentGoal === "ADDRESS") updateData.address = newVal;
    if (currentGoal === "ID") {
      if (newVal?.length === 11) updateData.nin_number = newVal;
      else updateData.cac_number = newVal;
    }
    if (currentGoal === "PREFERENCES") updateData.landlord_preferences = { info: newVal };

    // 5. THE FIX: Targeting the ID
    // If we have an existing row ID, we use UPDATE. If not, we UPSERT.
    if (latestListing.id && currentGoal !== "ADDRESS") {
      // Surgical strike: update ONLY the new info on the existing row
      await supabase.from('inspections').update(updateData).eq('id', latestListing.id);
    } else {
      // Create a new listing or update based on Phone + Address
      await supabase.from('inspections').upsert(updateData, { onConflict: 'landlord_phone, address' });
    }

    return sendTwiML(res, ai.reply);

  } catch (e) {
    return sendTwiML(res, "Thanks! Please provide the next detail.");
  }
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${msg}</Message></Response>`);
}
