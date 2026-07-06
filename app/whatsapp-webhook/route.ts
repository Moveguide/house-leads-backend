import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

export async function POST(req: Request) {
  const payload = await req.json();

  // Extract fields from Evolution API JSON layout
  const text = (
    payload.data?.message?.conversation || 
    payload.data?.message?.extendedTextMessage?.text || 
    ""
  ).trim();

  const remoteJid = payload.data?.key?.remoteJid || "";
  const phone = remoteJid.split('@')[0].trim();
  const base64Media = payload.data?.message?.base64 || null;

  // Guard clause
  if (!phone || payload.event === "SEND_MESSAGE") {
    return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
  }

  try {
    // --- YES/NO Logic ---
    const upperText = text.toUpperCase();
    if (upperText.startsWith('YES ') || upperText.startsWith('NO ')) {
      const parts = upperText.split(/\s+/);
      const applicationId = parts[1];

      if (applicationId) {
        const response = await fetch('https://app.moveguide.co/api/webhook/whatsapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-webhook-secret': process.env.WHATSAPP_WEBHOOK_SECRET! },
          body: JSON.stringify({ message: text, from: phone }),
        });
        const data = await response.json();
        const confirmMsg = data.success 
          ? (data.status === 'approved' ? '✅ Approved!' : '❌ Rejected.')
          : "Could not process response.";
        await sendMessage(phone, confirmMsg);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
    }

    // --- State Machine ---
    let { data: landlord, error: fetchError } = await supabase
      .from('landlords')
      .select('*')
      .eq('landlord_phone', phone)
      .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);

    const isReset = ["start", "reset", "new move"].includes(text.toLowerCase());

    if (!landlord || isReset) {
      const startStep = (landlord?.identity_verified) ? "ADDRESS" : "NAME";
      await supabase.from('landlords').upsert({ landlord_phone: phone, current_step: startStep }, { onConflict: 'landlord_phone' });
      
      const msg = landlord?.identity_verified 
        ? `Welcome back, ${landlord.landlord_name}! Address of new property?`
        : "Welcome! What is your full name?";
      await sendMessage(phone, msg);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    const step = landlord.current_step;

    // --- YOUR STEP LOGIC (Identical to your original) ---
    if (step === "NAME") {
      await supabase.from('landlords').update({ landlord_name: text, current_step: "NIN_CAC" }).eq('landlord_phone', phone);
      await sendMessage(phone, `Thanks! Send 11-digit NIN or CAC (BN/RC).`);
    } else if (step === "NIN_CAC") {
      let idData = /^\d{11}$/.test(text) ? { nin_number: text } : { cac_number: text.toUpperCase() };
      await supabase.from('landlords').update({ ...idData, current_step: "ID_UPLOAD" }).eq('landlord_phone', phone);
      await sendMessage(phone, "Got it! Upload a clear photo of your ID.");
    } else if (step === "ID_UPLOAD") {
      if (!base64Media) await sendMessage(phone, "Please send a photo of your ID.");
      else {
        const fileUrl = await uploadToSupabase(base64Media, `IDs/${phone}.jpg`);
        await supabase.from('landlords').update({ id_card_url: fileUrl, current_step: "ADDRESS", identity_verified: true }).eq('landlord_phone', phone);
        await sendMessage(phone, "Verified! What is the full address of the property?");
      }
    } else if (step === "ADDRESS") {
      const { data: prop } = await supabase.from('properties').insert({ landlord_phone: phone, address: text }).select().single();
      await supabase.from('landlords').update({ current_step: "PROOF_UPLOAD", last_property_id: prop.id }).eq('landlord_phone', phone);
      await sendMessage(phone, "Saved! Please upload Proof of Ownership.");
    } else if (step === "PROOF_UPLOAD") {
      if (!base64Media) await sendMessage(phone, "Please upload proof of ownership.");
      else {
        const fileUrl = await uploadToSupabase(base64Media, `proofs/${landlord.last_property_id}.jpg`);
        await supabase.from('properties').update({ ownership_proof_url: fileUrl }).eq('id', landlord.last_property_id);
        await supabase.from('landlords').update({ current_step: "PREFERENCES" }).eq('landlord_phone', phone);
        await sendMessage(phone, "Received! Any tenant preferences? Reply 'No' if none.");
      }
    } else if (step === "PREFERENCES") {
      await supabase.from('properties').update({ landlord_preferences: { note: text } }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "LISTING_TYPE" }).eq('landlord_phone', phone);
      await sendMessage(phone, "What type of accommodation? (1. Short Stay, 2. Tenancy, 3. Hotel, 4. Shared Apartment)");
    } else if (step === "LISTING_TYPE") {
      await supabase.from('properties').update({ listing_type: text }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "CONTRACT_DURATION" }).eq('landlord_phone', phone);
      await sendMessage(phone, "Minimum contract duration? (Daily, Monthly, Quarterly, Annually, 2 Years+)");
    } else if (step === "CONTRACT_DURATION") {
      await supabase.from('properties').update({ contract_duration: text }).eq('id', landlord.last_property_id);
      await supabase.from('inspections').insert({ property_id: landlord.last_property_id, status: 'assigned' });
      await supabase.from('landlords').update({ current_step: "DONE" }).eq('landlord_phone', phone);
      await sendMessage(phone, "Fantastic! Property queued for inspection. 🎉");
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// Helpers
async function uploadToSupabase(base64: string, path: string) {
  const buffer = Buffer.from(base64, 'base64');
  const { data } = await supabase.storage.from('landlord-documents').upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
  return supabase.storage.from('landlord-documents').getPublicUrl(path).data.publicUrl;
}

async function sendMessage(phone: string, msg: string) {
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/prod_line`, {
    method: 'POST',
    headers: { 'apikey': process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: phone, text: msg })
  });
}
