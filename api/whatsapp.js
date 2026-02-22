import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { Body, From } = req.body;
  const text = (Body || "").trim();
  const phone = (From || "").replace("whatsapp:", "").trim();

  try {
    // 1. Get the current state
    let { data: landlord, error: fetchError } = await supabase
      .from('landlords')
      .select('*')
      .eq('landlord_phone', phone)
      .maybeSingle();

    if (fetchError) throw new Error(`Fetch Fail: ${fetchError.message}`);

    // 2. The Reset Logic
    const isReset = ["start", "reset", "new property"].includes(text.toLowerCase());

    if (!landlord || isReset) {
      const { data: upserted, error: upsertErr } = await supabase
        .from('landlords')
        .upsert({ landlord_phone: phone, current_step: "NAME" }, { onConflict: 'landlord_phone' })
        .select()
        .single();

      if (upsertErr) throw new Error(`Upsert Fail: ${upsertErr.message}`);
      return sendTwiML(res, "Welcome! Let’s get started. What is the landlord's full name?");
    }

    // 3. The State Machine
    const step = landlord.current_step;

    if (step === "NAME") {
      const { error: updErr } = await supabase
        .from('landlords')
        .update({ landlord_name: text, current_step: "NIN_CAC" })
        .eq('landlord_phone', phone);

      if (updErr) throw new Error(`Name Update Fail: ${updErr.message}`);
      return sendTwiML(res, `Thanks, ${text}! Now, please send your 11-digit NIN or CAC (BN/RC).`);
    }

    if (step === "NIN_CAC") {
      let idData = {};
      if (/^\d{11}$/.test(text)) idData = { nin_number: text };
      else if (/^(BN|RC)/i.test(text)) idData = { cac_number: text.toUpperCase() };
      else return sendTwiML(res, "Invalid format. Send an 11-digit NIN or a CAC starting with BN/RC.");

      const { error: idErr } = await supabase
        .from('landlords')
        .update({ ...idData, current_step: "ADDRESS" })
        .eq('landlord_phone', phone);

      if (idErr) throw new Error(`ID Update Fail: ${idErr.message}`);
      return sendTwiML(res, "Identity verified. What is the full address of the property?");
    }

    if (step === "ADDRESS") {
      const { data: prop, error: propErr } = await supabase
        .from('properties')
        .insert({ landlord_phone: phone, address: text })
        .select().single();

      if (propErr) throw new Error(`Prop Insert Fail: ${propErr.message}`);

      await supabase
        .from('landlords')
        .update({ current_step: "PREFERENCES", last_property_id: prop.id })
        .eq('landlord_phone', phone);

      return sendTwiML(res, "Address saved! Any tenant preferences (e.g., 'no pets')? Reply 'No' if none.");
    }

    if (step === "PREFERENCES") {
      const prefs = text.toLowerCase() === "no" ? { note: "None" } : { note: text };
      
      await supabase.from('properties').update({ landlord_preferences: prefs }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "DONE" }).eq('landlord_phone', phone);

      return sendTwiML(res, "All done! We will notify you when an agent is assigned. Type 'New Property' to add another.");
    }

    return sendTwiML(res, "Registration complete! Type 'New Property' to add another.");

  } catch (err) {
    console.error(err);
    // This tells you EXACTLY what went wrong in WhatsApp
    return sendTwiML(res, `System Error: ${err.message}. Type 'Reset' to fix.`);
  }
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
}
