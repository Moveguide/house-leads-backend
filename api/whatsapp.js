import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  // 1. Handle Twilio Webhook nuances
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { Body, From } = req.body;
  const text = (Body || "").trim();
  const phone = (From || "").replace("whatsapp:", "").trim();

  try {
    // 2. Fetch or Create Landlord
    let { data: landlord } = await supabase
      .from('landlords')
      .select('*')
      .eq('landlord_phone', phone)
      .maybeSingle();

    // 3. Handle Start/Reset Command
    const isReset = ["start", "new property", "reset"].includes(text.toLowerCase());
    
    if (isReset || !landlord) {
      if (!landlord) {
        const { data: created } = await supabase
          .from('landlords')
          .upsert({ landlord_phone: phone, current_step: "NAME" })
          .select()
          .single();
        landlord = created;
      } else {
        await supabase
          .from('landlords')
          .update({ current_step: "NAME" })
          .eq('landlord_phone', phone);
      }

      return sendTwiML(res, "Welcome! Let’s get your property registered. What is the landlord's full name?");
    }

    // 4. State Machine Logic
    let currentStep = landlord.current_step || "NAME";
    let reply = "";

    switch (currentStep) {
      case "NAME":
        await supabase
          .from('landlords')
          .update({ landlord_name: text, current_step: "NIN_CAC" })
          .eq('landlord_phone', phone);
        
        reply = `Thanks, ${text}! Please provide your 11-digit NIN or your CAC number (starts with BN or RC).`;
        break;

      case "NIN_CAC":
        let nin = null;
        let cac = null;

        // Validation logic
        if (/^\d{11}$/.test(text)) {
          nin = text;
        } else if (/^(BN|RC)/i.test(text)) {
          cac = text.toUpperCase();
        } else {
          return sendTwiML(res, "That doesn't look like a valid NIN (11 digits) or CAC (starts with BN or RC). Please try again.");
        }

        await supabase
          .from('landlords')
          .update({ 
            nin_number: nin, 
            cac_number: cac, 
            current_step: "ADDRESS" 
          })
          .eq('landlord_phone', phone);

        reply = "Identity verified. Now, what is the full address of the property you are registering?";
        break;

      case "ADDRESS":
        // Create the property record
        const { data: prop, error: propErr } = await supabase
          .from('properties')
          .insert({
            landlord_phone: phone,
            address: text,
            status: 'pending_inspection'
          })
          .select()
          .single();

        if (propErr) throw propErr;

        // Save the ID of this specific property to the landlord's session
        await supabase
          .from('landlords')
          .update({ 
            current_step: "PREFERENCES", 
            last_property_id: prop.id 
          })
          .eq('landlord_phone', phone);

        reply = `Address saved! Finally, do you have any tenant preferences (e.g., 'Working professionals only')? Reply "No" if none.`;
        break;

      case "PREFERENCES":
        const finalPrefs = text.toLowerCase() === "no" ? { note: "None" } : { note: text };

        // Update the SPECIFIC property we just created
        await supabase
          .from('properties')
          .update({ landlord_preferences: finalPrefs })
          .eq('id', landlord.last_property_id);

        await supabase
          .from('landlords')
          .update({ current_step: "DONE" })
          .eq('landlord_phone', phone);

        reply = "Success! Your property is now queued for inspection. We will notify you once an agent is assigned. Type 'New Property' to add another.";
        break;

      case "DONE":
        reply = "You've already completed the registration. If you have another house, just type 'New Property'.";
        break;

      default:
        reply = "I'm not sure where we are. Type 'Start' to begin again.";
    }

    return sendTwiML(res, reply);

  } catch (err) {
    console.error("Critical Error:", err.message);
    return sendTwiML(res, "Sorry, I hit a snag. Please type 'Start' to refresh the session.");
  }
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
}
