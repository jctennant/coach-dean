import twilio from "twilio";

if (!process.env.TWILIO_ACCOUNT_SID)
  throw new Error("Missing TWILIO_ACCOUNT_SID");
if (!process.env.TWILIO_AUTH_TOKEN) throw new Error("Missing TWILIO_AUTH_TOKEN");
if (!process.env.TWILIO_PHONE_NUMBER)
  throw new Error("Missing TWILIO_PHONE_NUMBER");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export async function sendSMS(to: string, body: string) {
  // Twilio concatenates up to 1600 chars, but we aim for 2-4 segments (~320-640 chars)
  const message = await client.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER!,
    to,
  });
  return message;
}
