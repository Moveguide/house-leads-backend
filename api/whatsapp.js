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
    // 1. FETCH ALL DATA
    const { data: records } = await supabase
      .from('inspections')
      .select('*')
      .eq('landlord_phone', senderPhone);
    
    // Filter out any "junk" data from previous loops
    const knownName = records?.find(r => r.landlord_name && r.landlord_name.length > 3 && r.landlord_name !== "COMPLETED")?.landlord_name;
    const knownIDRecord = records?.find(r => (r.nin_number || r.cac_number) && r.nin_number !== "COMPLETED");
    const latestListing = records?.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || {};

    // 2. THE SECRET SAUCE: Hard-coded logic for the AI
    const hasName = !!knownName;
    const hasAddress = latestListing.address && latestListing.address !== "Pending" && latestListing.address !== "COMPLETED";
    const hasID = !!(knownIDRecord?.nin_number || knownIDRecord?.cac_number);
    const hasPrefs = !!(latestListing.landlord_preferences && Object.keys(latestListing.landlord_preferences).length > 0);

    // 3. AI EXTRACTION
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `You are a real estate data extractor. 
          Current Progress:
          - Name: ${hasName ? knownName : 'REQUIRED'}
          - Address: ${hasAddress ? latestListing.address : 'REQUIRED'}
          - ID (NIN/CAC): ${hasID ? 'RECEIVED' : 'REQUIRED'}
          - Prefs: ${hasPrefs ? 'RECEIVED' : 'REQUIRED'}

          TASK:
          1. Extract whatever info the user just sent.
          2. If you extract a Name, Address, or ID, return it in the JSON.
          3. Your 'reply' MUST ask for the VERY NEXT missing item in this order: Name -> Address -> ID -> Prefs.
          4. If they just gave the final info, say thanks and end.

          IMPORTANT: Do NOT use the word "COMPLETED" as a value for name or address.
          RETURN ONLY JSON: { "extracted_name", "extracted_address", "extracted_nin", "extracted_cac", "extracted_prefs", "reply" }` 
        },
        { role: "user", content: cleanBody }
      ],
      response_format: { type: "json_object" }
    });

    const ai = JSON.parse(completion.choices[0].message.content);

    // 4. DATA MAPPING (Ensures no overwriting with 'null' or 'COMPLETED')
    const updateData = {
      landlord_phone: senderPhone,
      landlord_name: ai.extracted_name || knownName || "Unknown",
      address: ai.extracted_address || (latestListing.address !== "COMPLETED" ? latestListing.address : null) || "Pending",
      nin_number: ai.extracted_nin || knownIDRecord?.nin_number || null,
      cac_number: ai.extracted_cac || knownIDRecord?.cac_number || null,
      landlord_preferences: ai.extracted_prefs || latestListing.landlord_preferences || {},
      status: 'assigned'
    };

    // 5. THE UPSERT
    // We use Phone + Address as the unique key to prevent duplicate rows
    await supabase.from('inspections').upsert(updateData, { onConflict: 'landlord_phone, address' });

    return sendTwiML(res, ai.reply);

  } catch (e) {
    console.error(e);
    return sendTwiML(res, "I've got that. What's the next detail?");
  }
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${msg}</Message></Response>`);
}
