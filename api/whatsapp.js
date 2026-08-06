import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

const POPULAR_BANKS = [
  { code: "011", name: "First Bank of Nigeria" },
  { code: "058", name: "GTBank" },
  { code: "057", name: "Zenith Bank" },
  { code: "044", name: "Access Bank" },
  { code: "90115", name: "OPay" },
  { code: "50515", name: "Moniepoint" },
  { code: "50211", name: "Kuda Bank" },
  { code: "214", name: "First City Monument Bank" }
];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { Body, From, MediaUrl0 } = req.body;
  const text = (Body || "").trim();
  const phone = (From || "").replace("whatsapp:", "").trim();

  try {
    // 1. Application Decision Pass-through
    const upperText = text.toUpperCase();
    if (upperText.startsWith('YES ') || upperText.startsWith('NO ')) {
      const parts = upperText.split(/\s+/);
      const applicationId = parts[1];

      if (applicationId) {
        const response = await fetch('https://app.moveguide.co/api/webhook/whatsapp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-webhook-secret': process.env.WHATSAPP_WEBHOOK_SECRET,
          },
          body: JSON.stringify({ message: text, from: phone }),
        });
        const data = await response.json();
        if (data.success) {
          const confirmMsg = data.status === 'approved'
            ? '✅ Application approved! The tenant will be notified to make payment.'
            : '❌ Application rejected. The tenant has been notified.';
          return sendTwiML(res, confirmMsg);
        }
        return sendTwiML(res, "Could not process this response. Please check the application ID.");
      }
    }

    // 2. Fetch Landlord Record
    let { data: landlord, error: fetchError } = await supabase
      .from('landlords')
      .select('*')
      .eq('landlord_phone', phone)
      .maybeSingle();

    if (fetchError) throw new Error(`Fetch Fail: ${fetchError.message}`);

    const isReset = ["start", "reset", "new move"].includes(text.toLowerCase());

    // 3. Smart Memory Reset / Onboarding Start
    if (!landlord || isReset) {
      const startStep = landlord?.identity_verified ? "ADDRESS" : "NAME";

      await supabase
        .from('landlords')
        .upsert({ landlord_phone: phone, current_step: startStep }, { onConflict: 'landlord_phone' });

      if (landlord?.identity_verified) {
        return sendTwiML(res, `Welcome back, ${landlord.landlord_name}! What is the full address of the new property?`);
      }
      return sendTwiML(res, "Welcome to Moveguide Residential! Let’s get started. What is your full name?");
    }

    const step = landlord.current_step;

    // --- STEP 1: NAME ---
    if (step === "NAME") {
      await supabase.from('landlords').update({ landlord_name: text, current_step: "NIN" }).eq('landlord_phone', phone);
      return sendTwiML(res, "Thanks! Please send your 11-digit National Identification Number (NIN).");
    }

    // --- STEP 2: NIN ---
    if (step === "NIN") {
      const cleanNIN = text.replace(/\D/g, '');
      if (!/^\d{11}$/.test(cleanNIN)) {
        return sendTwiML(res, "Invalid NIN. Please send a valid 11-digit NIN.");
      }
      await supabase.from('landlords').update({ nin_number: cleanNIN, current_step: "HOST_GENDER" }).eq('landlord_phone', phone);
      return sendTwiML(res, "Got it! Please select your gender:\n\n1. Male\n2. Female\n3. Prefer not to say\n\nReply with the number.");
    }

    // --- STEP 3: HOST GENDER ---
    if (step === "HOST_GENDER") {
      const map = { "1": "Male", "2": "Female", "3": "Other" };
      const selected = map[text];
      if (!selected) return sendTwiML(res, "Please reply with a number:\n\n1. Male\n2. Female\n3. Prefer not to say");

      await supabase.from('landlords').update({ landlord_gender: selected, current_step: "ID_UPLOAD" }).eq('landlord_phone', phone);
      return sendTwiML(res, "Thanks! Please upload a clear photo of your NIN ID card.");
    }

    // --- STEP 4: ID UPLOAD ---
    if (step === "ID_UPLOAD") {
      if (!MediaUrl0) return sendTwiML(res, "Please send a photo of your NIN ID card to proceed.");
      const fileUrl = await uploadToSupabase(MediaUrl0, `IDs/${phone}.jpg`);

      await supabase.from('landlords')
        .update({ id_card_url: fileUrl, current_step: "BANK_ACCOUNT", identity_verified: true })
        .eq('landlord_phone', phone);

      return sendTwiML(res, "ID received and verified! Please enter your 10-digit NUBAN account number for payouts.");
    }

    // --- STEP 5: BANK ACCOUNT NUMBER ---
    if (step === "BANK_ACCOUNT") {
      const accNo = text.replace(/\D/g, '');
      if (accNo.length !== 10) {
        return sendTwiML(res, "Please send a valid 10-digit bank account number.");
      }
      await supabase.from('landlords').update({ account_number: accNo, current_step: "BANK_SELECT" }).eq('landlord_phone', phone);

      let menu = "Select your bank by replying with the number:\n\n";
      POPULAR_BANKS.forEach((b, idx) => {
        menu += `${idx + 1}. ${b.name}\n`;
      });
      return sendTwiML(res, menu);
    }

    // --- STEP 6: BANK SELECT & PAYSTACK RESOLVE ---
    if (step === "BANK_SELECT") {
      const index = parseInt(text, 10) - 1;
      if (isNaN(index) || index < 0 || index >= POPULAR_BANKS.length) {
        return sendTwiML(res, "Invalid choice. Reply with a valid number from the list.");
      }

      const selectedBank = POPULAR_BANKS[index];
      const accountHolder = await resolvePaystackAccount(landlord.account_number, selectedBank.code);

      await supabase.from('landlords').update({
        bank_code: selectedBank.code,
        bank_name: selectedBank.name,
        account_name: accountHolder || "Unverified",
        current_step: "ADDRESS"
      }).eq('landlord_phone', phone);

      const confirmMsg = accountHolder
        ? `Account Verified: *${accountHolder}* (${selectedBank.name})\n\nWhat is the full address of the property?`
        : `Bank saved (${selectedBank.name}). What is the full address of the property?`;

      return sendTwiML(res, confirmMsg);
    }

    // --- STEP 7: ADDRESS ---
    if (step === "ADDRESS") {
      const { data: prop } = await supabase.from('properties').insert({
        landlord_phone: phone,
        address: text,
        listing_type: 'Residential'
      }).select().single();

      await supabase.from('landlords').update({ current_step: "BUILDING_TYPE", last_property_id: prop.id }).eq('landlord_phone', phone);

      return sendTwiML(res, "Address saved!\n\nWhat is the building type?\n\n1. Bungalow\n2. Duplex\n3. Terrace\n\nReply with the number.");
    }

    // --- STEP 8: BUILDING TYPE ---
    if (step === "BUILDING_TYPE") {
      const map = { "1": "Bungalow", "2": "Duplex", "3": "Terrace" };
      const selected = map[text];
      if (!selected) return sendTwiML(res, "Please reply with a number:\n\n1. Bungalow\n2. Duplex\n3. Terrace");

      await supabase.from('properties').update({ building_type: selected }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "STAY_CAPACITY" }).eq('landlord_phone', phone);

      return sendTwiML(res, "What is the stay capacity?\n\n1. Miniflat\n2. 1 Bed\n3. 2 Bed\n4. 3 Bed\n5. 4 Bed\n6. 5 Bed\n\nReply with the number.");
    }

    // --- STEP 9: STAY CAPACITY ---
    if (step === "STAY_CAPACITY") {
      const map = { "1": "Miniflat", "2": "1 Bed", "3": "2 Bed", "4": "3 Bed", "5": "4 Bed", "6": "5 Bed" };
      const selected = map[text];
      if (!selected) return sendTwiML(res, "Please reply with a number:\n\n1. Miniflat\n2. 1 Bed\n3. 2 Bed\n4. 3 Bed\n5. 4 Bed\n6. 5 Bed");

      await supabase.from('properties').update({ stay_capacity: selected }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "STAY_TYPE" }).eq('landlord_phone', phone);

      return sendTwiML(res, "What is the stay type?\n\n1. Solo Tenancy\n2. Shared Flat\n\nReply with the number.");
    }

    // --- STEP 10: STAY TYPE ---
    if (step === "STAY_TYPE") {
      const map = { "1": "Solo Tenancy", "2": "Shared Flat" };
      const selected = map[text];
      if (!selected) return sendTwiML(res, "Please reply with a number:\n\n1. Solo Tenancy\n2. Shared Flat");

      await supabase.from('properties').update({ stay_type: selected }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "SHARED_BUILDING" }).eq('landlord_phone', phone);

      return sendTwiML(res, "Is this property in a shared building/compound?\n\n1. Yes\n2. No\n\nReply with the number.");
    }

    // --- STEP 11: SHARED BUILDING ---
    if (step === "SHARED_BUILDING") {
      const map = { "1": true, "2": false };
      const selected = map[text];
      if (selected === undefined) return sendTwiML(res, "Please reply with a number:\n\n1. Yes\n2. No");

      await supabase.from('properties').update({ is_shared_building: selected }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "CONTRACT_DURATION" }).eq('landlord_phone', phone);

      return sendTwiML(res, "What is the minimum contract duration?\n\n1. Daily\n2. Monthly\n3. Quarterly\n4. Annually\n\nReply with the number.");
    }

    // --- STEP 12: CONTRACT DURATION ---
    if (step === "CONTRACT_DURATION") {
      const map = { "1": "Daily", "2": "Monthly", "3": "Quarterly", "4": "Annually" };
      const selected = map[text];
      if (!selected) return sendTwiML(res, "Please reply with a number:\n\n1. Daily\n2. Monthly\n3. Quarterly\n4. Annually");

      await supabase.from('properties').update({ contract_duration: selected }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "AMOUNT" }).eq('landlord_phone', phone);

      return sendTwiML(res, "What is the total price for this stay in NGN (inclusive of service charges/fees if any)?\nExample: 1,500,000 or 1500000");
    }

    // --- STEP 13: AMOUNT NORMALIZATION ---
    if (step === "AMOUNT") {
      const rawPrice = text.replace(/[^0-9.]/g, '');
      const parsedPrice = parseFloat(rawPrice);

      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        return sendTwiML(res, "Invalid amount. Please send a valid numeric price (e.g., 2500000 or 2500000).");
      }

      await supabase.from('properties').update({ amount: parsedPrice }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "PROOF_UPLOAD" }).eq('landlord_phone', phone);

      return sendTwiML(res, `Amount saved as ₦${parsedPrice.toLocaleString('en-NG')}.\n\nPlease upload a photo or document as Proof of Ownership.`);
    }

    // --- STEP 14: PROOF UPLOAD ---
    if (step === "PROOF_UPLOAD") {
      if (!MediaUrl0) return sendTwiML(res, "Please upload a photo of your ownership proof.");
      const fileUrl = await uploadToSupabase(MediaUrl0, `proofs/${landlord.last_property_id}.jpg`);

      await supabase.from('properties').update({ ownership_proof_url: fileUrl }).eq('id', landlord.last_property_id);
      await supabase.from('landlords').update({ current_step: "PREFERENCES" }).eq('landlord_phone', phone);

      return sendTwiML(res, "Proof received! Any specific tenant preferences (e.g., gender preferences, no pets)? Reply 'No' if none.");
    }

    // --- STEP 15: PREFERENCES & COMPLETION ---
    if (step === "PREFERENCES") {
      const prefs = text.toLowerCase() === "no" ? { note: "None" } : { note: text };
      await supabase.from('properties').update({ landlord_preferences: prefs }).eq('id', landlord.last_property_id);
      await supabase.from('inspections').insert({ property_id: landlord.last_property_id, status: 'assigned' });
      await supabase.from('landlords').update({ current_step: "DONE" }).eq('landlord_phone', phone);

      return sendTwiML(res, "Fantastic! Everything is saved. Your property is queued for inspection within 24 hours. 🎉");
    }

    return sendTwiML(res, "Registration complete! Type 'New Move' to add another residence.");

  } catch (err) {
    return sendTwiML(res, `System Error: ${err.message}. Type 'Reset' to restart.`);
  }
}

async function resolvePaystackAccount(accountNumber, bankCode) {
  if (!PAYSTACK_SECRET) return null;
  try {
    const res = await fetch(`https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });
    const data = await res.json();
    if (data.status && data.data) {
      return data.data.account_name;
    }
  } catch (e) {
    console.error("Paystack resolution error:", e.message);
  }
  return null;
}

async function uploadToSupabase(url, fileName) {
  const response = await fetch(url);
  const blob = await response.buffer();
  const { error } = await supabase.storage.from('landlord-documents').upload(fileName, blob, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(`Storage Fail: ${error.message}`);
  const { data: publicUrl } = supabase.storage.from('landlord-documents').getPublicUrl(fileName);
  return publicUrl.publicUrl;
}

function sendTwiML(res, msg) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
}
