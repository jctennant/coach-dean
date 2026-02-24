import { Suspense } from "react";
import { SignupForm } from "@/components/signup-form";
import { SmsMockup, type Message } from "@/components/sms-mockup";
import { Navbar } from "@/components/navbar";

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
  const smsPhone = process.env.LINQ_PHONE_NUMBER ?? "+18336373002";
  const smsUrl = `sms:${smsPhone}&body=Hi%20Dean!`;
  return (
    <div className="flex min-h-screen flex-col">
      <Navbar smsUrl={smsUrl} />

      {/* Hero */}
      <section id="get-started" className="mt-16 flex min-h-[calc(100svh-4rem)] items-center px-6 py-16">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-12 md:flex-row md:gap-16">
          {/* Text + form */}
          <div className="flex flex-1 flex-col items-center gap-6 text-center md:items-start md:text-left">
            <h1 className="max-w-xl font-serif text-4xl font-normal leading-tight tracking-tight md:text-5xl lg:text-5xl">
              Your training. Relentlessly adapted.
            </h1>
            <p className="max-w-lg text-lg text-muted-foreground">
            Dean tracks your training and injury history, learns how your body responds, 
            and texts you exactly what to do next — so you arrive at the start line healthy and ready for a new PR.
            </p>
            <Suspense>
              <SignupForm smsPhone={smsPhone} />
            </Suspense>
          </div>
          {/* SMS mockup */}
          <div className="flex flex-1 justify-center">
            <SmsMockup messages={heroMessages} className="mx-auto" />
          </div>
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
                <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
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

      {/* FAQ */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-10 text-center font-serif text-2xl font-normal md:text-3xl">
            Frequently asked questions
          </h2>
          <div className="divide-y">
            {[
              {
                q: "How is Coach Dean different from Runna or using ChatGPT to plan my workouts?",
                a: "Runna gives you a great static plan, but it doesn't know that you had a rough week, skipped two workouts, or ran your long run way too fast. Coach Dean lives in your text messages and adapts in real time — just reply with how a workout went and he'll adjust. ChatGPT can answer running questions, but it has no memory of your training history, no structured plan, and no one checking in on you. Dean combines the personalization of a real coach with the convenience of SMS — no app to open, no dashboard to check in on.",
              },
              {
                q: "What type of races can Coach Dean help me prepare for?",
                a: "Coach Dean can build training plans for 5Ks all the way up to ultramarathons, including half marathons, full marathons, and trail races. If you're training for a triathlon, he can factor in your swimming and cycling alongside your run training. Not sure what distance is right for you? Tell Dean where you're at and he'll help you figure it out.",
              },
              {
                q: "How does Coach Dean know what paces to assign my workouts?",
                a: "During onboarding, Dean asks for your recent race times or your comfortable conversational pace. From there he uses established training pace formulas to calculate your personal zones — easy, tempo, threshold, and interval — and builds every workout around those numbers. As you train and share feedback, Dean refines those paces over time. No guesswork, no one-size-fits-all pace charts.",
              },
              {
                q: "Do I need a GPS watch or Strava to use Coach Dean?",
                a: "Nope. All you need is a phone number. Coach Dean works entirely over SMS — no app to download, no account to create, no device required. If you do use Strava or a GPS watch, you can optionally connect it so Dean can pull your actual workout data automatically, but it's never required.",
              },
              {
                q: "How much does Coach Dean cost?",
                a: "Coach Dean is currently free during beta. We're focused on building something genuinely useful before charging for it. When pricing is introduced, early beta users will be the first to know — and we plan to take care of the people who believed in Dean early.",
              },
              {
                q: "What happens if I miss a workout or need to take a week off?",
                a: "Just tell Dean. Seriously — text him like you'd text a coach. Whether you missed a run, got sick, or needed a mental break, Dean will adjust your upcoming week to account for it and keep you on track toward your goal. Life happens, and a good coach works around it rather than ignoring it.",
              },
              {
                q: "Is my data private?",
                a: "Your training data, pace information, and conversations with Dean are used solely to power your coaching experience — nothing else. We don't sell your data or share it with third parties. If you connect Strava, that access is read-only and only used to pull your workout history into Dean. You can request deletion of your data at any time by texting Dean or emailing jake.c.tennant@gmail.com.",
              },
            ].map(({ q, a }) => (
              <details key={q} className="group py-4">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-4 font-medium">
                  <span>{q}</span>
                  <span className="mt-0.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="flex flex-col items-center gap-6 border-t bg-muted/40 px-6 py-16 text-center md:py-24">
        <h2 className="max-w-xl font-serif text-2xl font-normal md:text-3xl">
          Ready to run smarter?
        </h2>
        <Suspense>
          <SignupForm smsPhone={smsPhone} centered />
        </Suspense>
        <p className="max-w-sm text-[11px] leading-snug text-muted-foreground/70">
          By signing up, you agree to receive recurring SMS messages from Coach
          Dean at the number provided. Message and data rates may apply. Reply
          STOP to unsubscribe at any time. Reply HELP for support.
        </p>
      </section>

      {/* Footer */}
      <footer className="border-t px-6 py-10 text-center text-sm text-muted-foreground">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-3">
          <p className="font-medium text-foreground">CoachDeanAI</p>
          <p>
            Questions or feedback?{" "}
            <a
              href="mailto:jake.c.tennant@gmail.com"
              className="underline hover:text-foreground"
            >
              jake.c.tennant@gmail.com
            </a>
          </p>
          <div className="flex gap-4 text-xs">
            <a href="/privacy" className="underline hover:text-foreground">Privacy Policy</a>
            <a href="/terms" className="underline hover:text-foreground">Terms of Service</a>
          </div>
          <p className="text-xs text-muted-foreground/70">
            &copy; {new Date().getFullYear()} CoachDeanAI. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
