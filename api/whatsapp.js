import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Map steps
const STEPS = ["NAME", "NIN_CAC", "ADDRESS", "PREFERENCES", "DONE"];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { Body, From } = req.body;
  const text = (Body || "").trim();
  const phone = (From || "").replace("whatsapp:", "");

  try {
    // 1️⃣ Check if landlord exists
    let { data: landlord } = await supabase
      .from('landlords')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();

    // 1a. If message is "Start" or "New Property", create landlord if missing
    if (text.toLowerCase() === "start" || text.toLowerCase() === "new property") {
      if (!landlord) {
        const { data: newLandlord } = await supabase
          .from('landlords')
          .insert({ phone, created_at: new Date().toISOString(), name: null, preferences: {} })
          .select()
          .maybeSingle();
        landlord = newLandlord;
      }

      // Reset step
      await supabase
        .from('landlords')
        .update({ current_step: "NAME" })
        .eq('id', landlord.id);

      return sendTwiML(res, `Hi! Let’s register a property. Please send the landlord’s full name.`);
    }

    if (!landlord) {
      // If landlord not found and not a "Start" message
      return sendTwiML(res, `Please send "Start" or "New Property" to begin registering your property.`);
    }

    // 2️⃣ Determine current step
    let currentStep = landlord.current_step || "NAME";
    let reply = "";

    // 3️⃣ Handle each step
    switch (currentStep) {
      case "NAME":
        // Save landlord name
        await supabase
          .from('landlords')
          .update({ name: text, current_step: "NIN_CAC" })
          .eq('id', landlord.id);

        reply = `Thanks, ${text}! Please provide your NIN (11 digits) or CAC (starts with BN or RC).`;
        break;

      case "NIN_CAC":
        let nin = null;
        let cac = null;

        if (/^\d{11}$/.test(text)) nin = text;
        else if (/^(BN|RC)/i.test(text)) cac = text;

        if (!nin && !cac) {
          reply = `That doesn’t look like a valid NIN or CAC. Please send a valid NIN or CAC.`;
          break;
        }

        await supabase
          .from('landlords')
          .update({ nin_number: nin, cac_number: cac, current_step: "ADDRESS" })
          .eq('id', landlord.id);

        reply = `Got it! Now, please send the property address.`;
        break;

      case "ADDRESS":
        // Create a property
        const { data: newProperty } = await supabase
          .from('properties')
          .insert({
            landlord_id: landlord.id,
            address: text,
            status: 'active',
            created_at: new Date().toISOString()
          })
          .select()
          .maybeSingle();

        // Save property ID in landlord session (optional)
        await supabase
          .from('landlords')
          .update({ current_step: "PREFERENCES" })
          .eq('id', landlord.id);

        reply = `Property registered at "${text}". Any preferences for this property? If none, reply "No".`;
        break;

      case "PREFERENCES":
        // Save preferences as JSON
        let prefs = text.toLowerCase() === "no" ? {} : { notes: text };

        await supabase
          .from('landlords')
          .update({ preferences: prefs, current_step: "DONE" })
          .eq('id', landlord.id);

        reply = `All done for this property! You can send "New Property" to register another.`;
        break;

      case "DONE":
        reply = `You have completed a property registration. Send "New Property" to register another.`;
        break;

      default:
        reply = `Oops! Something went wrong. Send "Start" to begin registering a property.`;
    }

    return sendTwiML(res, reply);

  } catch (e) {
    console.error(e);
    return sendTwiML(res, `Something went wrong. Please send "Start" to try again.`);
  }
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${msg}</Message></Response>`);
}
