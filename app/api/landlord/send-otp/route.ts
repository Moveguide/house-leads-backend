import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const resend = new Resend(process.env.RESEND_API_KEY!);

export async function POST(req: Request) {
  try {
    const { landlordPhone, email } = await req.json();

    if (!email || !landlordPhone) {
      return NextResponse.json({ message: 'Email and phone are required' }, { status: 400 });
    }

    // Generate 6-digit numeric OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    // Store OTP in Supabase
    const { error: dbError } = await supabase
      .from('landlords')
      .update({
        email: email.toLowerCase().trim(),
        email_verified: false,
        verification_code: otpCode,
        code_expires_at: expiresAt,
      })
      .eq('landlord_phone', landlordPhone);

    if (dbError) {
      return NextResponse.json({ message: dbError.message }, { status: 500 });
    }

    // Send Email via Resend
    await resend.emails.send({
      from: 'Moveguide <no-reply@moveguide.co>',
      to: [email],
      subject: 'Verify your Moveguide Landlord Account',
      html: `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>Verify Your Email Address</h2>
          <p>Your 6-digit verification code is:</p>
          <h1 style="letter-spacing: 4px; color: #2563eb;">${otpCode}</h1>
          <p>This code will expire in 10 minutes.</p>
        </div>
      `,
    });

    return NextResponse.json({ status: 'success', message: 'OTP sent to email' });
  } catch (err: any) {
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}
