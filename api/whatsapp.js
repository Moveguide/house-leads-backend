import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { Body, From, MediaUrl0 } = req.body;
  const text = (Body || "").trim();
  const phone = (From || "").replace("whatsapp:", "").trim();

  try {

    // Handle application approval/rejection
const upperText = text.toUpperCase();
if (upperText.startsWith('YES ') || upperText.startsWith('NO ')) {
  const parts = upperText.split(/\s+/);
  const decision = parts[0]; // YES or NO
  const applicationId = parts[1]; // UUID

  if (applicationId) {
    try {
        const response = await fetch('https://app.moveguide.co/api/webhook/whatsapp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-webhook-secret': process.env.WHATSAPP_WEBHOOK_SECRET,
          },
          body: JSON.stringify({
            message: text,
            from: phone,
          }),
        });

        const data = await response.json();

        if (data.success) {
          const confirmMsg = data.status === 'approved'
            ? '✅ Application approved! The tenant will be notified to make payment.'
            : '❌ Application rejected. The tenant has been notified.';
          return sendTwiML(res, confirmMsg);
        } else {
          return sendTwiML(res, "Could not process this response. Please check the application ID and try again.");
        }
      } catch (err) {
        return sendTwiML(res, `Error processing response: ${err.message}`);
      }
    }
  }

    let { data: landlord, error: fetchError } = await supabase
      .from('landlords')
      .select('*')
      .eq('landlord_phone', phone)
      .maybeSingle();

    if (fetchError) throw new Error(`Fetch Fail: ${fetchError.message}`);

    const isReset = ["start", "reset", "new move"].includes(text.toLowerCase());

    // --- SMART MEMORY CHECK ---
    if (!landlord || isReset) {
      // If they are already verified, skip the intro and go to ADDRESS
      const startStep = (landlord?.identity_verified) ? "ADDRESS" : "NAME";
      
      const { data: upserted, error: upsertErr } = await supabase
        .from('landlords')
        .upsert({ landlord_phone: phone, current_step: startStep }, { onConflict: 'landlord_phone' })
        .select()
        .single();

      if (upsertErr) throw new Error(`Upsert Fail: ${upsertErr.message}`);
      
      if (landlord?.identity_verified) {
        return sendTwiML(res, `Welcome back, ${landlord.landlord_name}! What is the full address of the new property?`);
      }
      return sendTwiML(res, "Welcome to Moveguide! Note: You must be the legal owner/manager. Let’s get started. What is your full name?");
    }
    
    const step = landlord.current_step;

    if (step === "NAME") {
      await supabase.from('landlords').update({ landlord_name: text, current_step: "NIN_CAC" }).eq('landlord_phone', phone);
      return sendTwiML(res, `Thanks! Now, please send your 11-digit NIN or CAC (BN/RC).`);
    }

    if (step === "NIN_CAC") {
      let idData = {};
      if (/^\d{11}$/.test(text)) idData = { nin_number: text };
      else if (/^(BN|RC)/i.test(text)) idData = { cac_number: text.toUpperCase() };
      else return sendTwiML(res, "Invalid format. Send an 11-digit NIN or a CAC starting with BN/RC.");

      await supabase.from('landlords').update({ ...idData, current_step: "ID_UPLOAD" }).eq('landlord_phone', phone);
      return sendTwiML(res, "Got it! Please upload a clear photo of your NIN ID Card.");
    }

    if (step === "ID_UPLOAD") {
      if (!MediaUrl0) return sendTwiML(res, "Please send a photo of your NIN ID card to proceed.");
      const fileUrl = await uploadToSupabase(MediaUrl0, `IDs/${phone}.jpg`);
      
      // AUTO-VERIFY: status changes here once file is received
      await supabase.from('landlords')
        .update({ id_card_url: fileUrl, current_step: "ADDRESS", identity_verified: true })
        .eq('landlord_phone', phone);

      return sendTwiML(res, "ID received and account verified! What is the full address of the property?");
    }

    if (step === "ADDRESS") {
      const { data: prop } = await supabase.from('properties').insert({ landlord_phone: phone, address: text }).select().single();
      await supabase.from('landlords').update({ current_step: "PROOF_UPLOAD", last_property_id: prop.id }).eq('landlord_phone', phone);
      return sendTwiML(res, "Address saved! Please upload a photo/PDF as Proof of Ownership.");
    }

    if (step === "PROOF_UPLOAD") {
      if (!MediaUrl0) return sendTwiML(res, "Please upload a photo of your ownership proof.");
      const fileUrl = await uploadToSupabase(MediaUrl0, `proofs/${landlord.last_property_id}.jpg`);
      
      await supabase.from('properties').update({ ownership_proof_url: fileUrl }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "PREFERENCES" }).eq('landlord_phone', phone);
      return sendTwiML(res, "Proof received! Any tenant preferences? Reply 'No' if none.");
    }

    if (step === "PREFERENCES") {
      const prefs = text.toLowerCase() === "no" ? { note: "None" } : { note: text };
      await supabase.from('properties').update({ landlord_preferences: prefs }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "LISTING_TYPE" }).eq('landlord_phone', phone);
      return sendTwiML(res, `What type of accommodation is this listing?\n\n1. Short Stay\n2. Tenancy\n3. Hotel\n4. Shared Apartment\n\nReply with the number.`);
    }

  if (step === "LISTING_TYPE") {
    const accommodationMap = {
      "1": "Short Stay",
      "2": "Tenancy", 
      "3": "Hotel",
      "4": "Shared Apartment",
      "short stay": "Short Stay",
      "tenancy": "Tenancy",
      "hotel": "Hotel",
      "shared apartment": "Shared Apartment",
    };

    const accommodationType = accommodationMap[text.toLowerCase()] || accommodationMap[text];
    if (!accommodationType) {
      return sendTwiML(res, `Please reply with a number:\n\n1. Short Stay\n2. Tenancy\n3. Hotel\n4. Shared Apartment`);
    }

    await supabase.from('properties').update({ listing_type: accommodationType }).eq('id', landlord.last_property_id);
    await supabase.from('landlords').update({ current_step: "CONTRACT_DURATION" }).eq('landlord_phone', phone);
    return sendTwiML(res, `What is the minimum contract duration?\n\n1. Daily\n2. Monthly\n3. Quarterly\n4. Bi-annually\n5. Annually\n6. 2 Years+\n\nReply with the number.`);
  }

  if (step === "CONTRACT_DURATION") {
    const durationMap = {
      "1": "Daily",
      "2": "Monthly",
      "3": "Quarterly",
      "4": "Bi-annually",
      "5": "Annually",
      "6": "2 Years+",
      "daily": "Daily",
      "monthly": "Monthly",
      "quarterly": "Quarterly",
      "bi-annually": "Bi-annually",
      "annually": "Annually",
      "2 years+": "2 Years+",
    };

    const contractDuration = durationMap[text.toLowerCase()] || durationMap[text];
    if (!contractDuration) {
      return sendTwiML(res, `Please reply with a number:\n\n1. Daily\n2. Monthly\n3. Quarterly\n4. Bi-annually\n5. Annually\n6. 2 Years+`);
    }

    await supabase.from('properties').update({ contract_duration: contractDuration }).eq('id', landlord.last_property_id);
    await supabase.from('inspections').insert({ property_id: landlord.last_property_id, status: 'assigned' });
    await supabase.from('landlords').update({ current_step: "DONE" }).eq('landlord_phone', phone);
    return sendTwiML(res, "Fantastic! Everything is saved. Your property is now queued for inspection in 24 hours. 🎉");
  }

    return sendTwiML(res, "Registration complete! Type 'New Move' to add another residence.");

  } catch (err) {
    return sendTwiML(res, `System Error: ${err.message}. Type 'Reset' to fix.`);
  }
}

async function uploadToSupabase(url, fileName) {
  const response = await fetch(url);
  const blob = await response.buffer();
  const { data, error } = await supabase.storage.from('landlord-documents').upload(fileName, blob, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(`Storage Fail: ${error.message}`);
  const { data: publicUrl } = supabase.storage.from('landlord-documents').getPublicUrl(fileName);
  return publicUrl.publicUrl;
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
}
