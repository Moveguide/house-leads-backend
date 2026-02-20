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
    // 1. FETCH ALL DATA FOR THIS PHONE
    const { data: records } = await supabase
      .from('inspections')
      .select('*')
      .eq('landlord_phone', senderPhone);
    
    // Find the current state of this user
    const knownName = records?.find(r => r.landlord_name && r.landlord_name !== "COMPLETED")?.landlord_name;
    const knownIDRecord = records?.find(r => r.nin_number || r.cac_number);
    const latestListing = records?.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || {};

    // 2. LOGIC: Determine exactly what we are looking for
    let currentGoal = "NAME";
    if (knownName) currentGoal = "ADDRESS";
    if (knownName && latestListing.address && latestListing.address !== "Pending") currentGoal = "ID";
    if (knownName && latestListing.address && (knownIDRecord?.nin_number || knownIDRecord?.cac_number)) currentGoal = "PREFERENCES";

    // 3. AI: Only extract the specific goal
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `You are an extractor. The user is trying to provide their ${currentGoal}.
          - Extract the value. 
          - If the user is giving an ADDRESS, extract the full location.
          - If the user is giving an ID, check if it's an 11-digit NIN or a CAC (starts with BN or RC).
          - Write a short, friendly reply asking for the NEXT step in this sequence: Name -> Address -> NIN/CAC -> Preferences.
          
          RETURN ONLY JSON: { "extracted_value": "string", "reply": "string" }` 
        },
        { role: "user", content: cleanBody }
      ],
      response_format: { type: "json_object" }
    });

    const ai = JSON.parse(completion.choices[0].message.content);
    const newVal = ai.extracted_value;

    // 4. MAP EXTRACTED DATA TO CORRECT COLUMNS
    const updateData = {
      landlord_phone: senderPhone,
      landlord_name: currentGoal === "NAME" ? newVal : (knownName || "Unknown"),
      address: currentGoal === "ADDRESS" ? newVal : (latestListing.address || "Pending"),
      nin_number: (currentGoal === "ID" && newVal?.length === 11) ? newVal : (knownIDRecord?.nin_number || null),
      cac_number: (currentGoal === "ID" && (newVal?.startsWith('BN') || newVal?.startsWith('RC'))) ? newVal : (knownIDRecord?.cac_number || null),
      landlord_preferences: currentGoal === "PREFERENCES" ? newVal : (latestListing.landlord_preferences || {}),
      status: 'assigned'
    };

    // 5. UPSERT TO SUPABASE
    await supabase.from('inspections').upsert(updateData, { onConflict: 'landlord_phone, address' });

    return sendTwiML(res, ai.reply);

  } catch (e) {
    console.error(e);
    return sendTwiML(res, "Thanks! What is the next detail (Name, Address, or ID)?");
  }
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${msg}</Message></Response>`);
}
