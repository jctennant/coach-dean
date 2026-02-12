import { Suspense } from "react";
import { SignupForm } from "@/components/signup-form";
import { SmsMockup, type Message } from "@/components/sms-mockup";

/* ------------------------------------------------------------------ */
/*  SMS conversations for each section                                 */
/* ------------------------------------------------------------------ */

const heroMessages: Message[] = [
  {
    from: "coach",
    text: "Great run today! 5.2 mi in 42:18 — that's an 8:08/mi pace, right in your easy zone. Your consistency this week is paying off.",
  },
  {
    from: "user",
    text: "Thanks! Felt good but my left knee was a little tight around mile 3",
  },
  {
    from: "coach",
    text: "Good to flag that. Since it eased up, it's likely just tightness from the tempo on Tuesday. Add 5 min of quad/IT band rolling tonight. If it shows up again tomorrow, we'll swap your long run for a bike day.",
  },
  {
    from: "user",
    text: "Will do. What's on the schedule tomorrow?",
  },
  {
    from: "coach",
    text: "Rest day — you've earned it. Wednesday is 4x800m at 7:15 pace with 90s jog recovery. We're building toward that half marathon PR.",
  },
];

const weeklyPlanMessages: Message[] = [
  {
    from: "coach",
    text: "Here's your week 8 schedule — we're in the build phase now:\n\nMon: Rest\nTue: 5 mi easy (8:30 pace)\nWed: 6x800m @ 7:10 w/ 90s jog\nThu: 4 mi recovery\nFri: 45 min bike or swim\nSat: 12 mi long run (8:40 pace)\nSun: 30 min easy + strides",
  },
  {
    from: "user",
    text: "Saturday might be tough, I have a family thing in the morning",
  },
  {
    from: "coach",
    text: "No problem — let's shift the long run to Sunday and make Saturday your rest day. I'll adjust the rest of the week so you're fresh for it.",
  },
];

const adaptiveMessages: Message[] = [
  {
    from: "coach",
    text: "I noticed your easy pace has dropped from 8:45 to 8:15 over the last 3 weeks, and your heart rate is lower at the same effort. Your aerobic base is building nicely.",
  },
  {
    from: "coach",
    text: "I'm bumping your interval paces from 7:15 to 7:05 this week. Your tempo runs move to 7:30. These should feel challenging but controlled.",
  },
  {
    from: "user",
    text: "Love it, I was starting to feel like the intervals were getting easier",
  },
];

const askAnythingMessages: Message[] = [
  {
    from: "user",
    text: "I've got a half marathon in 3 weeks. Should I still be doing long runs?",
  },
  {
    from: "coach",
    text: "Great timing — you're entering taper. This week is your last long run (10 mi), then we scale back. Next week drops to 8, and race week is all easy running with a few strides. Trust the fitness you've built.",
  },
  {
    from: "user",
    text: "What about nutrition for race day?",
  },
  {
    from: "coach",
    text: "For a half, eat your normal pre-run meal 2-3 hrs before. Take a gel at mile 5 and another at mile 9. Practice this on your long run Saturday so there are no surprises.",
  },
];

/* ------------------------------------------------------------------ */
/*  Value prop sections (alternating layout)                           */
/* ------------------------------------------------------------------ */

const valueProps = [
  {
    title: "Your week, planned and adapted",
    description:
      "Every week, Dean lays out your complete training schedule with specific paces, distances, and purpose for each session. Life gets in the way? Just text Dean and he'll rearrange your week on the fly.",
    messages: weeklyPlanMessages,
  },
  {
    title: "Training that evolves with you",
    description:
      "Dean tracks your pace trends, heart rate, and consistency across weeks — not just individual runs. As your fitness improves, your paces and volume adjust automatically. No manual spreadsheet updates.",
    messages: adaptiveMessages,
  },
  {
    title: "Ask anything, any time",
    description:
      "Nutrition, injuries, race strategy, taper plans, cross-training — text Dean like you'd text a friend. He knows your full training history and gives specific advice, not generic tips.",
    messages: askAnythingMessages,
  },
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Hero */}
      <section className="flex flex-col items-center gap-8 px-6 pt-24 pb-16 text-center md:pt-32 md:pb-24">
        <h1 className="max-w-2xl text-4xl font-bold leading-tight tracking-tight md:text-5xl lg:text-6xl">
          Your AI running coach, just a text away
        </h1>
        <p className="max-w-lg text-lg text-muted-foreground">
          Dean analyzes every run and texts you personalized feedback, workouts,
          and race plans. Fewer injuries, more PRs.
        </p>
        <Suspense>
          <SignupForm />
        </Suspense>
        <p className="text-xs text-muted-foreground">
          Free during beta &middot; US phone numbers only &middot; Takes 30 seconds
        </p>
      </section>

      {/* SMS Mockup — hero showcase */}
      <section className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-4 text-center text-2xl font-semibold md:text-3xl">
            Coaching that feels like texting a friend
          </h2>
          <p className="mx-auto mb-12 max-w-lg text-center text-muted-foreground">
            Real conversation, not canned replies. Dean remembers your history,
            adapts to your goals, and keeps it concise.
          </p>
          <SmsMockup messages={heroMessages} className="mx-auto" />
        </div>
      </section>

      {/* Value props — alternating layout */}
      {valueProps.map((prop, i) => {
        const reversed = i % 2 === 1;
        return (
          <section
            key={i}
            className={`border-t px-6 py-16 md:py-24 ${i % 2 === 0 ? "bg-muted/40" : ""}`}
          >
            <div
              className={`mx-auto flex max-w-5xl flex-col items-center gap-12 md:flex-row md:gap-16 ${
                reversed ? "md:flex-row-reverse" : ""
              }`}
            >
              {/* Text */}
              <div className="flex-1 text-center md:text-left">
                <h2 className="mb-4 text-2xl font-semibold md:text-3xl">
                  {prop.title}
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  {prop.description}
                </p>
              </div>
              {/* Mockup */}
              <div className="flex-1 flex justify-center">
                <SmsMockup messages={prop.messages} />
              </div>
            </div>
          </section>
        );
      })}

      {/* Multi-sport mention */}
      <section className="border-t px-6 py-16 text-center md:py-20">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-4 text-2xl font-semibold md:text-3xl">
            Not just running
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Training for a triathlon? Dean coaches across running, cycling, and
            swimming — all from the same text thread. One coach, every discipline.
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="flex flex-col items-center gap-6 border-t bg-muted/40 px-6 py-16 text-center md:py-24">
        <h2 className="max-w-xl text-2xl font-semibold md:text-3xl">
          Ready to run smarter?
        </h2>
        <Suspense>
          <SignupForm />
        </Suspense>
      </section>

      {/* Footer */}
      <footer className="border-t px-6 py-8 text-center text-sm text-muted-foreground">
        &copy; {new Date().getFullYear()} Coach Dean. Built with Claude.
      </footer>
    </div>
  );
}
