import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — CoachDeanAI",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 md:py-24">
      <div className="mb-8">
        <Link href="/" className="text-sm text-muted-foreground underline hover:text-foreground">
          ← Back to home
        </Link>
      </div>

      <h1 className="mb-2 text-3xl font-bold">Privacy Policy</h1>
      <p className="mb-10 text-sm text-muted-foreground">Last updated: February 2026</p>

      <div className="space-y-8 text-sm leading-relaxed text-foreground/80">
        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">1. What We Collect</h2>
          <p>When you sign up for Coach Dean, we collect and store the following:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Your phone number</li>
            <li>Running and fitness data you share via Strava (activities, pace, mileage, heart rate)</li>
            <li>Information you provide during onboarding (goals, race dates, experience, schedule preferences)</li>
            <li>The full history of SMS messages exchanged between you and Coach Dean</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">2. How We Use Your Data</h2>
          <p>
            All data collected is used solely to provide the Coach Dean AI coaching service — to
            analyze your training history, generate personalized workout plans, and send you coaching
            feedback via SMS. We do not use your data for advertising or unrelated purposes.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">3. Data Sharing</h2>
          <p>
            We do not sell, rent, or share your personal data with third parties for their own
            purposes. Data is processed through the following services solely to operate Coach Dean:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Anthropic (Claude AI) — to generate coaching responses</li>
            <li>Twilio — to send and receive SMS messages</li>
            <li>Strava — to retrieve your activity data (only if you connect your account)</li>
            <li>Supabase — to store your profile and conversation history</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">4. SMS Messaging</h2>
          <p>
            By signing up, you consent to receive recurring SMS messages from Coach Dean. Message
            frequency varies based on your training schedule and activity. Message and data rates may
            apply.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Reply <strong>STOP</strong> at any time to unsubscribe and stop receiving messages.</li>
            <li>Reply <strong>HELP</strong> for support information.</li>
          </ul>
          <p className="mt-2">
            For additional support, email{" "}
            <a href="mailto:jake.c.tennant@gmail.com" className="underline hover:text-foreground">
              jake.c.tennant@gmail.com
            </a>.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">5. Data Retention</h2>
          <p>
            We retain your data for as long as your account is active. If you unsubscribe (STOP) or
            request deletion, we will remove your personal data from our systems within 30 days.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">6. Your Rights &amp; Deletion Requests</h2>
          <p>
            You can request access to or deletion of your data at any time by emailing{" "}
            <a href="mailto:jake.c.tennant@gmail.com" className="underline hover:text-foreground">
              jake.c.tennant@gmail.com
            </a>{" "}
            with the subject line "Data Deletion Request" and your phone number. We will respond
            within 10 business days.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">7. Changes to This Policy</h2>
          <p>
            We may update this policy from time to time. If we make material changes, we will notify
            active users via SMS. Continued use of the service after changes constitutes acceptance
            of the updated policy.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">8. Contact</h2>
          <p>
            Questions about this policy? Email{" "}
            <a href="mailto:jake.c.tennant@gmail.com" className="underline hover:text-foreground">
              jake.c.tennant@gmail.com
            </a>.
          </p>
        </section>
      </div>
    </div>
  );
}
