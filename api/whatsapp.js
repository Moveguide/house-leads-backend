import { createClient } from '@supabase/supabase-js';

// ---------------------------
// Supabase client using SERVICE_ROLE key
// ---------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------
// Helper to send Twilio-compatible XML response
// ---------------------------
function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<Response><Message>${msg}</Message></Response>`);
}

// ---------------------------
// WhatsApp Handler
// ---------------------------
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { Body, From } = req.body;
  const msg = (Body || "").trim();
  const phone = (From || "").replace('whatsapp:', '');

  try {
    // 1. Check if landlord exists
    let { data: landlord } = await supabase
      .from('landlords')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();

    // 2. Welcome message / Start
    if (!landlord || msg.toLowerCase() === "start") {
      if (!landlord) {
        const { data: newLandlord, error } = await supabase
          .from('landlords')
          .insert({
            phone,
            name: null,
            preferences: {},
            nin_number: null,
            cac_number: null
          })
          .select()
          .single();

        if (error) {
          console.error("Landlord insert error:", error);
          return sendTwiML(res, "System error. Please try again later.");
        }
        landlord = newLandlord;
      }

      return sendTwiML(
        res,
        `Welcome! To register a new property, type "New Property". We'll guide you step by step.`
      );
    }

    // 3. Handle new property flow
    if (msg.toLowerCase() === "new property") {
      const { data: property, error } = await supabase
        .from('properties')
        .insert({
          landlord_id: landlord.id,
          address: null,
          status: 'active'
        })
        .select()
        .single();

      if (error) {
        console.error("Property insert error:", error);
        return sendTwiML(res, "Could not create property. Try again later.");
      }

      return sendTwiML(
        res,
        `Great! Let's register this property. Please send the full address of the property.`
      );
    }

    // 4. Find the last active property for this landlord
    const { data: activeProperty } = await supabase
      .from('properties')
      .select('*')
      .eq('landlord_id', landlord.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!activeProperty) {
      return sendTwiML(
        res,
        `Please start by typing "New Property" to register your first property.`
      );
    }

    // 5. Update property with address
    if (!activeProperty.address) {
      const { error } = await supabase
        .from('properties')
        .update({ address: msg })
        .eq('id', activeProperty.id);

      if (error) {
        console.error("Property update error:", error);
        return sendTwiML(res, "Could not save address. Try again.");
      }

      return sendTwiML(
        res,
        `Address saved! Next, please send your NIN (11 digits) or CAC (starts with BN/RC).`
      );
    }

    // 6. Save NIN or CAC
    if (!landlord.nin_number && /^\d{11}$/.test(msg)) {
      const { error } = await supabase
        .from('landlords')
        .update({ nin_number: msg })
        .eq('id', landlord.id);

      if (error) {
        console.error("NIN update error:", error);
        return sendTwiML(res, "Could not save NIN. Try again.");
      }

      return sendTwiML(
        res,
        `NIN saved! Now you can send any preferences for this property, e.g., rent, amenities, etc. Or type "All Done" if finished.`
      );
    }

    if (!landlord.cac_number && /^(BN|RC)/i.test(msg)) {
      const { error } = await supabase
        .from('landlords')
        .update({ cac_number: msg })
        .eq('id', landlord.id);

      if (error) {
        console.error("CAC update error:", error);
        return sendTwiML(res, "Could not save CAC. Try again.");
      }

      return sendTwiML(
        res,
        `CAC saved! Now you can send any preferences for this property, e.g., rent, amenities, etc. Or type "All Done" if finished.`
      );
    }

    // 7. Save preferences
    if (msg.toLowerCase() !== "all done") {
      const { error } = await supabase
        .from('properties')
        .update({ notes: msg })
        .eq('id', activeProperty.id);

      if (error) {
        console.error("Preferences update error:", error);
        return sendTwiML(res, "Could not save preferences. Try again.");
      }

      return sendTwiML(
        res,
        `Preferences saved! Type "All Done" if finished with this property.`
      );
    }

    // 8. Mark property complete
    await supabase
      .from('properties')
      .update({ status: 'completed' })
      .eq('id', activeProperty.id);

    return sendTwiML(
      res,
      `All done for this property! You can type "New Property" to register another property.`
    );

  } catch (err) {
    console.error("WhatsApp handler error:", err);
    return sendTwiML(res, `Something went wrong. Please send "Start" to try again.`);
  }
}
