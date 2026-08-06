import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // Bypass RLS for background webhook updates
);

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const paystackSignature = req.headers.get('x-paystack-signature');

    if (!paystackSignature) {
      return NextResponse.json({ message: 'Missing Paystack signature' }, { status: 400 });
    }

    // 1. Verify Cryptographic Signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!)
      .update(rawBody)
      .digest('hex');

    if (hash !== paystackSignature) {
      console.error('Invalid Paystack signature verification.');
      return NextResponse.json({ message: 'Invalid signature' }, { status: 401 });
    }

    const event = JSON.parse(rawBody);

    // 2. Process Successful Payment Event
    if (event.event === 'charge.success') {
      const paymentData = event.data;
      const reference = paymentData.reference;
      const amountPaid = paymentData.amount / 100; // Convert Kobo to NGN
      const customerEmail = paymentData.customer?.email;
      const metadata = paymentData.metadata || {};

      const applicationId = metadata.application_id;
      const propertyId = metadata.property_id;

      // 3. Log Payment to Supabase
      const { error: logError } = await supabase.from('payments').insert({
        paystack_reference: reference,
        amount: amountPaid,
        customer_email: customerEmail,
        application_id: applicationId || null,
        property_id: propertyId || null,
        status: 'success',
        raw_payload: paymentData,
      });

      if (logError) {
        console.error('Failed to log payment to Supabase:', logError.message);
      }

      // 4. Update Tenant Application & Property Status
      if (applicationId) {
        const { data: application, error: appError } = await supabase
          .from('applications')
          .update({
            payment_status: 'paid',
            status: 'confirmed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', applicationId)
          .select('*, properties(*, landlords(*))')
          .single();

        if (appError) {
          console.error('Failed to update application:', appError.message);
        } else if (application?.properties?.landlords?.landlord_phone) {
          // 5. Trigger WhatsApp Notification to Landlord
          const landlordPhone = application.properties.landlords.landlord_phone;
          const propertyAddress = application.properties.address || 'your property';

          await sendWhatsAppNotification(
            landlordPhone,
            `🎉 *Payment Received!*\n\n` +
              `Rent for *${propertyAddress}* has been successfully paid.\n` +
              `• *Amount:* ₦${amountPaid.toLocaleString('en-NG')}\n` +
              `• *Reference:* ${reference}\n\n` +
              `The payout is being processed to your registered account.`
          );
        }
      }
    }

    // Always respond 200 OK to Paystack
    return NextResponse.json({ status: 'success' }, { status: 200 });
  } catch (err: any) {
    console.error('Paystack Webhook Handler Error:', err.message);
    return NextResponse.json({ message: 'Webhook processing failed' }, { status: 500 });
  }
}

/**
 * Twilio WhatsApp Alert Helper
 */
async function sendWhatsAppNotification(toPhone: string, messageBody: string) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. "whatsapp:+14155238886"

  if (!accountSid || !authToken || !fromPhone) {
    console.warn('Twilio credentials missing. Skipping WhatsApp notification.');
    return;
  }

  const formattedTo = toPhone.startsWith('whatsapp:') ? toPhone : `whatsapp:${toPhone}`;

  try {
    const params = new URLSearchParams({
      To: formattedTo,
      From: fromPhone,
      Body: messageBody,
    });

    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  } catch (error: any) {
    console.error('Failed to send WhatsApp message via Twilio:', error.message);
  }
}
