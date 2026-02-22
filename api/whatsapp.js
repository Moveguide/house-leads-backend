import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { Body, From } = req.body;
  const message = (Body || "").trim();
  const phone = (From || "").replace('whatsapp:', '');

  try {
    // 1. Get the latest property (row) that is not DONE
    let { data: row } = await supabase
      .from('inspections')
      .select('*')
      .eq('landlord_phone', phone)
      .neq('current_step', 'DONE')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // 2. If no active row exists, create a new one
    if (!row) {
      const { data } = await supabase
        .from('inspections')
        .insert({ landlord_phone: phone, current_step: 'NAME', address: 'Pending' })
        .select()
        .single();
      row = data;
    }

    // 3. Determine the next step based on current_step
    let reply = '';
    let update = {};

    switch(row.current_step) {
      case 'NAME':
        update = { landlord_name: message, current_step: 'ADDRESS' };
        reply = 'Thanks! What is your property address?';
        break;

      case 'ADDRESS':
        // If this address already exists in the table, create a new row instead
        const { data: existing } = await supabase
          .from('inspections')
          .select('*')
          .eq('landlord_phone', phone)
          .eq('address', message)
          .limit(1);

        if (existing?.length > 0) {
          // Duplicate address → start a new row
          const { data: newRow } = await supabase
            .from('inspections')
            .insert({ landlord_phone: phone, current_step: 'ID', address: message })
            .select()
            .single();
          row = newRow;
          reply = 'Got it! Please provide your NIN (11-digit) or CAC (starts with BN or RC) for this property.';
        } else {
          update = { address: message, current_step: 'ID' };
          reply = 'Got it! Please provide your NIN (11-digit) or CAC (starts with BN or RC).';
        }
        break;

      case 'ID':
        if (message.startsWith('BN') || message.startsWith('RC')) {
          update = { cac_number: message, current_step: 'PREFERENCES' };
        } else if (/^\d{11}$/.test(message)) {
          update = { nin_number: message, current_step: 'PREFERENCES' };
        } else {
          reply = 'Invalid ID. Please send a valid 11-digit NIN or CAC.';
        }

        if (!reply) reply = 'Thanks! Any preferences for tenants?';
        break;

      case 'PREFERENCES':
        update = { landlord_preferences: message, current_step: 'DONE' };
        reply = 'All done for this property! You can send another address to register a new property.';
        break;

      case 'DONE':
        reply = 'We already have all info for this property. Send a new property address to add another.';
        break;

      default:
        update = { current_step: 'NAME' };
        reply = 'Please provide your name to get started.';
        break;
    }

    // 4. Update current row in database
    if (Object.keys(update).length) {
      await supabase
        .from('inspections')
        .update(update)
        .eq('id', row.id);
    }

    // 5. Send reply to WhatsApp
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(`<Response><Message>${reply}</Message></Response>`);

  } catch (err) {
    console.error(err);
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(`<Response><Message>Something went wrong. Please try again.</Message></Response>`);
  }
}
