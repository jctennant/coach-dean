import Link from "next/link";

export const metadata = {
  title: "Terms of Service — CoachDeanAI",
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 md:py-24">
      <div className="mb-8">
        <Link href="/" className="text-sm text-muted-foreground underline hover:text-foreground">
          ← Back to home
        </Link>
      </div>

      <h1 className="mb-2 text-3xl font-bold">Terms of Service</h1>
      <p className="mb-10 text-sm text-muted-foreground">Last updated: February 2026</p>

      <div className="space-y-8 text-sm leading-relaxed text-foreground/80">
        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">1. The Service</h2>
          <p>
            Coach Dean is an AI-powered running coaching service that communicates with you
            exclusively via SMS. Coach Dean provides personalized training plans, workout feedback,
            and coaching advice based on information you provide and, optionally, data from your
            Strava account.
          </p>
          <p className="mt-2">
            Coach Dean is currently in beta. Features, availability, and pricing may change at any
            time. The service is provided as-is with no uptime guarantees.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">2. Eligibility</h2>
          <p>
            Coach Dean is available to users with a valid US phone number. By signing up, you
            confirm that you are at least 18 years old and that the phone number you provide belongs
            to you.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">3. SMS Opt-In &amp; Opt-Out</h2>
          <p>
            By providing your phone number and signing up, you expressly consent to receive recurring
            automated SMS messages from Coach Dean at the number provided. Message frequency varies
            based on your training schedule. Message and data rates may apply.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Reply <strong>STOP</strong> to cancel at any time. You will receive a confirmation
              message and no further messages will be sent.
            </li>
            <li>
              Reply <strong>HELP</strong> to receive support information.
            </li>
          </ul>
          <p className="mt-2">
            For support, contact{" "}
            <a href="mailto:jake.c.tennant@gmail.com" className="underline hover:text-foreground">
              jake.c.tennant@gmail.com
            </a>.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">4. Not Medical or Professional Coaching Advice</h2>
          <p>
            Coach Dean is an AI system and is not a licensed personal trainer, physician, or
            certified running coach. The training plans and advice provided are for informational
            purposes only and do not constitute professional medical or athletic coaching advice.
          </p>
          <p className="mt-2">
            Always consult a qualified healthcare provider before beginning a new exercise program,
            especially if you have a history of injury or medical conditions. If you experience pain,
            dizziness, or discomfort during exercise, stop immediately and seek medical attention.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">5. Beta Service Disclaimer</h2>
          <p>
            Coach Dean is currently in beta. The service is provided "as is" without warranty of any
            kind. We make no guarantees about the accuracy, completeness, or timeliness of coaching
            recommendations. Features may change, be temporarily unavailable, or be discontinued
            without notice.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">6. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, CoachDeanAI and its operators shall not be
            liable for any indirect, incidental, special, or consequential damages arising from your
            use of the service — including but not limited to injury, loss of data, or missed
            training goals. Your sole remedy for dissatisfaction with the service is to stop using
            it.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">7. Privacy</h2>
          <p>
            Your use of Coach Dean is also governed by our{" "}
            <Link href="/privacy" className="underline hover:text-foreground">
              Privacy Policy
            </Link>
            , which explains what data we collect and how we use it.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">8. Changes to These Terms</h2>
          <p>
            We may update these terms from time to time. If we make material changes, we will notify
            active users via SMS. Continued use of the service after changes constitutes acceptance
            of the updated terms.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">9. Contact</h2>
          <p>
            Questions about these terms? Email{" "}
            <a href="mailto:jake.c.tennant@gmail.com" className="underline hover:text-foreground">
              jake.c.tennant@gmail.com
            </a>.
          </p>
        </section>
      </div>
    </div>
  );
}
