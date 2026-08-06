import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const resend = new Resend(process.env.RESEND_API_KEY!);

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

    const landlord = app?.properties?.landlords;
    const address = app?.properties?.address || 'your property';

    // 3. Dispatch Email Alert to Landlord via Resend
    if (landlord?.email) {
      await resend.emails.send({
        from: 'Moveguide Payments <payments@moveguide.co>',
        to: [landlord.email],
        subject: `Rent Payment Received - ${address}`,
        html: `
          <div style="font-family: sans-serif; line-height: 1.6;">
            <h2>Rent Payment Confirmed</h2>
            <p>Rent for <strong>${address}</strong> has been received successfully.</p>
            <ul>
              <li><strong>Amount Paid:</strong> ₦${amountPaid.toLocaleString('en-NG')}</li>
              <li><strong>Payment Reference:</strong> ${reference}</li>
            </ul>
            <p>The payout is being processed to your registered account.</p>
          </div>
        `,
      });
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
