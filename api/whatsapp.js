import neo4j from 'neo4j-driver';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  const { Body, From } = req.body;
  const senderPhone = (From || "").replace('whatsapp:', '').trim();
  const userInput = (Body || "").trim();

  try {
    // 1. FETCH ONLY THE NECESSARY FIELDS
    // We get the latest record to see where we left off
    const { data: records } = await supabase
      .from('inspections')
      .select('id, landlord_name, address, nin_number, cac_number, landlord_preferences')
      .eq('landlord_phone', senderPhone)
      .order('created_at', { ascending: false });

    const latest = records?.[0] || {};
    
    // Check global status (ignoring "Pending" or empty strings)
    const hasName = records?.some(r => r.landlord_name && r.landlord_name.length > 2 && r.landlord_name !== "Pending");
    const hasAddress = (latest.address && latest.address !== "Pending");
    const hasID = records?.some(r => r.nin_number || r.cac_number);

    // 2. LOGIC: What are we looking for?
    let step = "NAME";
    if (hasName) step = "ADDRESS";
    if (hasName && hasAddress) step = "ID";
    if (hasName && hasAddress && hasID) step = "PREFERENCES";

    // 3. AI EXTRACTION
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `You are a real estate assistant. User is at the ${step} stage.
          Sequence: Name -> Address -> ID -> Preferences.
          Extract the ${step} and ask for the next item in the sequence. 
          JSON ONLY: {"val": "string", "reply": "string"}` 
        },
        { role: "user", content: userInput }
      ],
      response_format: { type: "json_object" }
    });

    const ai = JSON.parse(completion.choices[0].message.content);

    // 4. THE SURGERY (Targeted Update)
    // We only send the specific column we want to change.
    let payload = { landlord_phone: senderPhone };
    
    if (step === "NAME") payload.landlord_name = ai.val;
    if (step === "ADDRESS") payload.address = ai.val;
    if (step === "ID") {
        if (ai.val.length === 11) payload.nin_number = ai.val;
        else payload.cac_number = ai.val;
    }
    if (step === "PREFERENCES") payload.landlord_preferences = { details: ai.val };

    // 5. THE SAVE
    if (latest.id && step !== "ADDRESS") {
        // If the row exists, ONLY update the new field. This ignores all those NULLs!
        await supabase.from('inspections').update(payload).eq('id', latest.id);
    } else {
        // If it's a new name or new house, we create a fresh row
        await supabase.from('inspections').upsert(payload, { onConflict: 'landlord_phone, address' });
    }

    return sendTwiML(res, ai.reply);

  } catch (e) {
    console.error(e);
    return sendTwiML(res, "I've noted that. What's the next detail?");
  }
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${msg}</Message></Response>`);
}
