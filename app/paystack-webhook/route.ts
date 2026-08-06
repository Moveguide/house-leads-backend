import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const paystackSignature = req.headers.get('x-paystack-signature');

    if (!paystackSignature) {
      return NextResponse.json({ message: 'Missing signature' }, { status: 400 });
    }

    // Verify HMAC SHA512 signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!)
      .update(rawBody)
      .digest('hex');

    if (hash !== paystackSignature) {
      return NextResponse.json({ message: 'Invalid signature' }, { status: 401 });
    }

    const event = JSON.parse(rawBody);

    if (event.event === 'charge.success') {
      const paymentData = event.data;
      const metadata = paymentData.metadata || {};

      // Route based on transaction metadata
      switch (metadata.type) {
        case 'rent_payment':
          await handleRentPayment(paymentData);
          break;

        case 'user_app_subscription':
          await handleUserAppSubscription(paymentData);
          break;

        default:
          // Fallback handler for existing/untyped legacy payments
          await handleDefaultPayment(paymentData);
          break;
      }
    }

    return NextResponse.json({ status: 'success' }, { status: 200 });
  } catch (err: any) {
    console.error('Webhook error:', err.message);
    return NextResponse.json({ message: 'Webhook handler failed' }, { status: 500 });
  }
}

/**
 * Handler: Landlord Rent Payments
 */
async function handleRentPayment(paymentData: any) {
  const reference = paymentData.reference;
  const amountPaid = paymentData.amount / 100;
  const metadata = paymentData.metadata || {};

  // 1. Record payment in Supabase
  await supabase.from('payments').insert({
    paystack_reference: reference,
    amount: amountPaid,
    customer_email: paymentData.customer?.email,
    application_id: metadata.application_id || null,
    property_id: metadata.property_id || null,
    status: 'success',
    raw_payload: paymentData,
  });

  // 2. Update Application & Property status
  if (metadata.application_id) {
    const { data: app } = await supabase
      .from('applications')
      .update({ payment_status: 'paid', status: 'confirmed' })
      .eq('id', metadata.application_id)
      .select('*, properties(*, landlords(*))')
      .single();

    // 3. Notify Landlord via Twilio WhatsApp API
    const landlordPhone = app?.properties?.landlords?.landlord_phone;
    if (landlordPhone) {
      await sendWhatsAppNotification(
        landlordPhone,
        `🎉 *Rent Payment Received!*\n\n` +
          `Property: *${app.properties.address}*\n` +
          `Amount: ₦${amountPaid.toLocaleString('en-NG')}\n` +
          `Ref: ${reference}`
      );
    }
  }
}

/**
 * Handler: App Subscriptions / General App Charges
 */
async function handleUserAppSubscription(paymentData: any) {
  const reference = paymentData.reference;
  const amountPaid = paymentData.amount / 100;

  await supabase.from('user_subscriptions').insert({
    paystack_reference: reference,
    amount: amountPaid,
    customer_email: paymentData.customer?.email,
    status: 'active',
  });
}

/**
 * Fallback Handler for unspecified payment types
 */
async function handleDefaultPayment(paymentData: any) {
  console.log('Processed untyped payment:', paymentData.reference);
}

/**
 * Twilio WhatsApp Alert Helper
 */
async function sendWhatsAppNotification(toPhone: string, messageBody: string) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_WHATSAPP_NUMBER;

  if (!accountSid || !authToken || !fromPhone) return;

  const formattedTo = toPhone.startsWith('whatsapp:') ? toPhone : `whatsapp:${toPhone}`;

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
}
