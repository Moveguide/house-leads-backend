import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { Body, From } = req.body;
  const message = (Body || "").trim();
  const phone = (From || "").replace('whatsapp:', '');

  try {
    // 1. Get latest inspection row for this landlord
    let { data: row } = await supabase
      .from('inspections')
      .select('*')
      .eq('landlord_phone', phone)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // 2. If no row exists, create it
    if (!row) {
      const { data } = await supabase
        .from('inspections')
        .insert({ landlord_phone: phone, current_step: 'NAME', address: 'Pending' })
        .select()
        .single();
      row = data;
    }

    // 3. Determine next step based on current_step
    let reply = '';
    let update = {};

    switch(row.current_step) {
      case 'NAME':
        update = { landlord_name: message, current_step: 'ADDRESS' };
        reply = 'Thanks! What is your property address?';
        break;

      case 'ADDRESS':
        update = { address: message, current_step: 'ID' };
        reply = 'Got it! Please provide your NIN (11-digit) or CAC (starts with BN or RC).';
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
        reply = 'All done! Thanks for providing your info.';
        break;

      case 'DONE':
        reply = 'We already have all your info. Thank you!';
        break;

      default:
        update = { current_step: 'NAME' };
        reply = 'Please provide your name to get started.';
        break;
    }

    // 4. Update row in database
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
