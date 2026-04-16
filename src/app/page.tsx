import { Suspense } from "react";
import { SignupForm } from "@/components/signup-form";
import { IMessageMockup } from "@/components/imessage-mockup";
import { Navbar } from "@/components/navbar";
import { RaceMarquee } from "@/components/race-marquee";

/* ------------------------------------------------------------------ */
/*  Insight card — static iMessage snippet                             */
/* ------------------------------------------------------------------ */

const SYS_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";

function InsightCard({
  context,
  tag,
  tagColor,
  messages,
}: {
  context: string;
  tag: string;
  tagColor: string;
  messages: Array<{ from: "dean" | "user"; text: string }>;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      {/* iMessage header */}
      <div
        style={{
          background: "#f2f2f7",
          borderBottom: "1px solid rgba(0,0,0,0.10)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: "50%",
            background: "#1a5c35",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: SYS_FONT,
              fontSize: 11,
              fontWeight: 600,
              color: "#ffffff",
              letterSpacing: 0.4,
              lineHeight: 1,
            }}
          >
            CD
          </span>
        </div>
        <div>
          <p
            style={{
              fontFamily: SYS_FONT,
              fontSize: 13,
              fontWeight: 600,
              color: "#000",
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            Coach Dean
          </p>
          <p
            style={{
              fontFamily: SYS_FONT,
              fontSize: 11,
              color: "#8e8e93",
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            {context}
          </p>
        </div>
      </div>

      {/* Bubbles */}
      <div
        style={{
          padding: "14px 14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          flex: 1,
        }}
      >
        {messages.map((msg, i) => {
          const isUser = msg.from === "user";
          return (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
              }}
            >
              <p
                style={{
                  maxWidth: "85%",
                  margin: 0,
                  padding: "9px 13px",
                  borderRadius: 18,
                  fontFamily: SYS_FONT,
                  fontSize: 14,
                  fontWeight: 400,
                  lineHeight: 1.45,
                  background: isUser ? "#0B84FE" : "#e9e9eb",
                  color: isUser ? "#ffffff" : "#000000",
                  wordBreak: "break-word",
                }}
              >
                {msg.text}
              </p>
            </div>
          );
        })}
      </div>

      {/* Tag */}
      <div
        style={{
          borderTop: "1px solid rgba(0,0,0,0.06)",
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: tagColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: SYS_FONT,
            fontSize: 11,
            fontWeight: 500,
            color: "#8e8e93",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {tag}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Value prop sections (alternating layout)                           */
/* ------------------------------------------------------------------ */

const valueProps = [
  {
    title: "Instant coaching after every run",
    description:
      "Connect Strava and Coach Dean analyzes every activity the moment it syncs — pace trends, effort, whether you went out too hard. Real feedback on your actual runs, not a generic \"great job\" notification.",
    screenshot: "/screenshot-2.png",
  },
  {
    title: "Works alongside the plan you already have",
    description:
      "Already on a Runna or TrainingPeaks plan? Coach Dean doesn't replace it — he reads it. Upload your plan to the dashboard and Dean will reference it directly when he analyzes your runs. You keep the structure; Dean adds the insight layer your app is missing.",
    screenshot: "/screenshot-plan-complement.png", // ⚠️ NEW VISUAL NEEDED: conversation or dashboard showing Dean referencing an uploaded Runna/TP plan
  },
  {
    title: "A personalized plan in minutes",
    description:
      "No plan yet? Answer a few questions over text and Coach Dean builds a training plan tailored to your goal, schedule, and fitness level — ready to go before you put your phone down.",
    screenshot: "/screenshot-1.png",
  },
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function Home() {
  const smsPhone = process.env.LINQ_PHONE_NUMBER ?? "+18336373002";
  // Use `?` (not `&`) per RFC 5724, and a literal space so the OS SMS app
  // doesn't pass "%20" through as literal characters in the message body.
  const smsUrl = `sms:${smsPhone}?body=Hi Coach Dean!`;
  return (
    <div className="flex min-h-screen flex-col" style={{ minHeight: "100vh" }}>
      <Navbar smsUrl={smsUrl} />

      {/* Hero */}
      <section id="get-started" className="flex items-center px-6" style={{ minHeight: "100vh", paddingTop: "calc(4rem + 48px)", paddingBottom: "48px" }}>
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-12 md:flex-row md:items-center md:gap-16">
          {/* Text + form */}
          <div className="flex flex-1 flex-col items-center gap-6 text-center md:items-start md:text-left" style={{ maxWidth: 480 }}>
            <h1 className="font-serif text-4xl font-normal leading-tight tracking-tight md:text-5xl lg:text-5xl">
              The running coach who explains every run.
            </h1>
            <p className="text-lg" style={{ color: "#4a4a4a" }}>
              Connect Strava and Coach Dean sends you a coaching note after every run — what the effort actually meant, what to watch for, what&apos;s next. Works alongside any plan you already have, or builds one from scratch. All over text.
            </p>
            <Suspense>
              <SignupForm smsPhone={smsPhone} />
            </Suspense>
          </div>
          {/* iPhone mockup */}
          <div className="flex flex-1 justify-center">
            <IMessageMockup />
          </div>
        </div>
      </section>

      <RaceMarquee />

      {/* Comparison: Coach Dean vs alternatives */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-5xl">
          {/* Header */}
          <div className="mb-12 text-center">
            <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
              The intelligence layer your training is missing.
            </h2>
            <p className="mx-auto max-w-xl leading-relaxed text-muted-foreground">
              Apps give you a plan. Garmin gives you data. What neither gives you is someone who synthesizes it all and tells you what to do next. Coach Dean is the connective tissue — real coaching delivered over text, powered by your actual runs, available to everyone.
            </p>
          </div>

          {/* Comparison cards */}
          <div className="grid gap-4 md:grid-cols-3 mb-16">
            {/* Training without coaching */}
            <div className="rounded-2xl border border-gray-200 bg-white p-6 flex flex-col gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Training without coaching</p>
                <p className="font-serif text-lg font-normal text-gray-700">Apps alone</p>
              </div>
              <ul className="text-sm leading-relaxed text-muted-foreground flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Plan tells you what to do — nothing explains why</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> &ldquo;Workout Complete&rdquo; is the only feedback you get</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Load builds blind — no one flags what&apos;s coming</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Injury questions go to Google</li>
              </ul>
              <p className="text-sm font-medium text-gray-500">~$10–20 / month</p>
            </div>

            {/* Coach Dean — featured */}
            <div className="rounded-2xl bg-gray-900 p-6 flex flex-col gap-4 text-white md:-mt-4 md:-mb-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">The intelligence layer</p>
                <p className="font-serif text-lg font-normal">Coach Dean</p>
              </div>
              <ul className="text-sm leading-relaxed text-gray-300 flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Coaching note after every Strava run</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Tracks weekly load — flags injury risk before it derails training</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Works alongside Runna, TrainingPeaks, or any plan</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Direct text access — ask anything, any time</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Builds a plan from scratch if you need one</li>
              </ul>
              <p className="text-sm font-medium text-gray-300">Free to start, then $10 / month</p>
            </div>

            {/* Human coach */}
            <div className="rounded-2xl border border-gray-200 bg-white p-6 flex flex-col gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Private coach</p>
                <p className="font-serif text-lg font-normal text-gray-700">The gold standard</p>
              </div>
              <ul className="text-sm leading-relaxed text-muted-foreground flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Weekly adaptation — requires a call to change anything</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Detailed feedback, but often delayed</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Scheduled calls &amp; email only</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> High friction: schedules, logins, check-ins</li>
              </ul>
              <p className="text-sm font-medium text-gray-500">$150–300 / month</p>
            </div>
          </div>

          {/* The Coach Dean Difference */}
          <div>
            <h3 className="mb-8 text-center font-serif text-xl font-normal md:text-2xl">
              The Coach Dean Difference
            </h3>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-2xl border border-gray-100 bg-gray-50 p-6">
                <p className="mb-2 font-semibold text-gray-900">Reads every run, not just the totals</p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  An app sees a slow pace. Coach Dean sees high humidity, the tail end of a hard week, and tells you that you actually ran that perfectly. Your data tells a story — Dean reads it.
                </p>
              </div>
              <div className="rounded-2xl border border-gray-100 bg-gray-50 p-6">
                <p className="mb-2 font-semibold text-gray-900">Injury patterns caught early</p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Most injuries don&apos;t appear out of nowhere — they build over weeks. Coach Dean tracks your load over time and flags warning signs before a niggle becomes a DNS. And when something does flare up, text him. You get a specific protocol, not a Google rabbit hole.
                </p>
              </div>
              <div className="rounded-2xl border border-gray-100 bg-gray-50 p-6">
                <p className="mb-2 font-semibold text-gray-900">Adapts when life gets in the way</p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Sick, traveling, ran too hard yesterday — text Dean. He adjusts around your reality instead of logging a missed workout as a failure. A good coach works with your life, not against it.
                </p>
              </div>
              <div className="rounded-2xl border border-gray-100 bg-gray-50 p-6">
                <p className="mb-2 font-semibold text-gray-900">Invisible tech</p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  No new app to download, no dashboard to check daily. Coach Dean syncs with Strava and talks to you where you already are: your messages. It just shows up after every run.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Insights section — concrete Dean message examples */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-12 text-center">
            <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
              Dean reads the signals most coaches miss.
            </h2>
            <p className="mx-auto max-w-xl leading-relaxed text-muted-foreground">
              Not &ldquo;great run!&rdquo; notifications. Actual analysis from your Strava data — the kind that changes what you do next.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            {/* Insight 1 — Load management (protecting gains, not fear) */}
            <InsightCard
              context="After a big training week"
              tag="Load management"
              tagColor="#0891b2"
              messages={[
                { from: "dean", text: "Big week — you've logged 43% more than your 4-week average. That's real training stimulus. Keep Friday short and easy so your body can actually absorb it. Fitness built on fresh legs sticks; fitness stacked on top of fatigue tends not to." },
              ]}
            />

            {/* Insight 2 — Aerobic efficiency improvement (purely positive) */}
            <InsightCard
              context="Your 6-week progress check"
              tag="Fitness progress"
              tagColor="#16a34a"
              messages={[
                { from: "dean", text: "Your aerobic efficiency is up 9% over the last 6 weeks — you're running the same pace at a meaningfully lower heart rate. That's your base building in real time. Keep the easy days truly easy and this trend will carry you right through your build phase." },
              ]}
            />

            {/* Insight 3 — Pace execution (more fitness than your pacing showed) */}
            <InsightCard
              context="After today's 10-mile long run"
              tag="Pace execution"
              tagColor="#2563eb"
              messages={[
                { from: "user", text: "Just finished — felt really tough toward the end" },
                { from: "dean", text: "Your splits show 8:55 first half, 9:42 second — that gap usually means there's more fitness there than your pacing gave you credit for. Try starting at 9:30 next week and let the back half open up. You might surprise yourself." },
              ]}
            />
          </div>
        </div>
      </section>

      {/* Value props — alternating layout */}
      {valueProps.map((prop, i) => {
        const reversed = i % 2 === 1;
        return (
          <section
            key={i}
            className={`border-t px-6 py-16 md:py-24 ${i % 2 === 1 ? "bg-muted/40" : ""}`}
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
              {/* Screenshot */}
              <div className="flex-1 flex justify-center">
                <img
                  src={prop.screenshot}
                  alt={prop.title}
                  className="w-full object-contain"
                  style={{ maxWidth: "min(380px, 100%)", maxHeight: 520 }}
                />
              </div>
            </div>
          </section>
        );
      })}

      {/* Full season plan arc */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-10 text-center">
            <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
              Your full season, laid out before you start
            </h2>
            <p className="mx-auto max-w-xl leading-relaxed text-muted-foreground">
              Every phase from base building to race-day taper, visible in one view. Coach Dean texts you the specifics each week and updates the plan as your training evolves. Already following a Runna or TrainingPeaks plan? Upload it to the dashboard and Dean will reference it alongside every run.
            </p>
          </div>

          {/* Plan arc visualization */}
          <div className="rounded-2xl border border-gray-200 bg-white p-6 md:p-8">
            {/* Race header */}
            <div className="mb-6 flex items-end justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-0.5">Sample plan</p>
                <p className="text-base font-semibold text-gray-900">Dipsea Trail Race · 7.4 mi</p>
                <p className="text-sm text-gray-500 mt-0.5">June 14, 2026</p>
              </div>
              <div className="text-right">
                <p className="text-3xl font-bold text-gray-900 leading-none">81</p>
                <p className="text-xs text-gray-400 mt-0.5">days to go</p>
              </div>
            </div>

            {/* Week blocks */}
            <div className="mb-4 grid grid-cols-12 gap-1 md:gap-1.5">
              {[
                { phase: "base" },
                { phase: "base" },
                { phase: "base" },
                { phase: "deload" },
                { phase: "base", current: true },
                { phase: "build" },
                { phase: "build" },
                { phase: "deload" },
                { phase: "peak" },
                { phase: "taper" },
                { phase: "taper" },
                { phase: "taper" },
              ].map((w, i) => {
                const colors: Record<string, string> = {
                  base: "bg-sky-200",
                  build: "bg-orange-200",
                  deload: "bg-green-200",
                  peak: "bg-red-200",
                  taper: "bg-purple-200",
                };
                return (
                  <div key={i} className="flex flex-col items-center gap-1">
                    <div
                      className={`h-8 w-full rounded md:h-10 ${colors[w.phase]} ${w.current ? "ring-2 ring-gray-900 ring-offset-1" : ""}`}
                    />
                    <span className="text-[9px] text-gray-400 leading-none hidden md:block">
                      W{i + 1}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Legend + current week callout */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-3">
                {[
                  { label: "Base", color: "bg-sky-200" },
                  { label: "Build", color: "bg-orange-200" },
                  { label: "Deload", color: "bg-green-200" },
                  { label: "Peak", color: "bg-red-200" },
                  { label: "Taper", color: "bg-purple-200" },
                ].map(({ label, color }) => (
                  <span key={label} className="flex items-center gap-1.5 text-xs text-gray-500">
                    <span className={`inline-block h-2.5 w-2.5 rounded-sm ${color}`} />
                    {label}
                  </span>
                ))}
              </div>
              <span className="text-xs text-gray-400 flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm ring-2 ring-gray-900 ring-offset-1 bg-sky-200" />
                You are here
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-10 text-center font-serif text-2xl font-normal md:text-3xl">
            Frequently asked questions
          </h2>
          <div className="divide-y">
            {[
              {
                q: "I already use Runna / TrainingPeaks / a coaching plan — should I still use Coach Dean?",
                a: (
                  <>
                    <p>Yes — and this is actually our most common use case. Coach Dean works alongside your existing plan, not as a replacement. Keep your Runna structure; Dean adds what no app does: a coaching note after every run, a direct line for training questions, and injury pattern flagging before small aches become big problems.</p>
                    <p className="mt-3">You can upload your plan as a PDF to the dashboard and Dean will reference it directly when he gives you feedback. So instead of "you ran 8:45 pace," you get "that was your recovery day — 8:45 with 140bpm HR is exactly right, your legs should feel fresher by Thursday."</p>
                  </>
                ),
              },
              {
                q: "Can Coach Dean help me if I'm not training for a specific race?",
                a: (
                  <>
                    <p>Absolutely — no race on the calendar required. Plenty of Dean&apos;s athletes are focused on building consistent mileage, staying healthy through a high-mileage stretch, or returning from injury. If you&apos;re coming back from something, Dean will ask about your current status and build your program around staying healthy first, performance second.</p>
                    <p className="mt-3">If you just want to run more consistently and stop getting hurt every time you ramp up, that&apos;s a perfectly complete goal. Dean tracks your load, checks in after every run, and flags patterns before they become injuries.</p>
                  </>
                ),
              }, 
              {
                q: "What type of races can Coach Dean help me prepare for?",
                a: "Coach Dean can build training plans for 5Ks all the way up to ultramarathons, including half marathons, full marathons, and trail races. If you're training for a triathlon, he focuses on the run leg — your running program will be dialed in, but for swim and bike you'd want dedicated coaching alongside. Not sure what distance is right for you? Tell Coach Dean where you're at and he'll help you figure it out.",
              },
              {
                q: "How does Coach Dean know what paces to assign my workouts?",
                a: (
                  <>
                    <p>The best way is to connect Strava during onboarding. Coach Dean pulls your full activity history — recent paces, long run efforts, workout splits — and uses that to build a real picture of your current fitness before your first plan is written. No questionnaire can replace actual data.</p>
                    <p className="mt-3">If you don&apos;t use Strava, Coach Dean asks for a recent race time or your comfortable conversational pace and calculates your training zones from there using established pace formulas (the same ones elite coaches use). As you train and share feedback over text, those zones get refined over time.</p>
                  </>
                ),
              },
              {
                q: "Do I need a GPS watch or Strava to use Coach Dean?",
                a: (
                  <>
                    <p>No — all you need is a phone number. Coach Dean works entirely over SMS with no app, account, or device required.</p>
                    <p className="mt-3">That said, connecting Strava unlocks the best version of Coach Dean. He&apos;ll analyze your history to build a sharper plan from day one, and send you coaching feedback within minutes of every run finishing — pace trends, effort level, whether the workout matched the intent. It&apos;s the feature testers have found most valuable.</p>
                  </>
                ),
              },
              {
                q: "How much does Coach Dean cost?",
                a: "It's free for the first 7 days — cancel with no penalties. After that, $10/mo on an annual plan or $20/mo month-to-month.",
              },
              {
                q: "What training philosophy does Coach Dean follow?",
                a: "Dean applies evidence-based principles used by elite coaches — polarized 80/20 training (easy runs truly easy, hard days genuinely hard), Lydiard-style aerobic base building before race-specific work, and Jack Daniels VDOT pacing for accurate zone calculation. He also incorporates targeted strength and mobility work — single-leg and hip exercises that keep runners healthy and absorbing load through a full season. The specifics are always adapted to your fitness level, schedule, and goal race.",
              },
              {
                q: "What happens if I miss a workout or need to take a week off?",
                a: "Just tell Coach Dean. Seriously — text him like you'd text a coach. Whether you missed a run, got sick, or needed a mental break, Coach Dean will adjust your upcoming week to account for it and keep you on track toward your goal. Life happens, and a good coach works around it rather than ignoring it.",
              },
              {
                q: "Are there any special commands I can text Coach Dean?",
                a: (
                  <>
                    <p>Beyond just chatting, a few keywords trigger specific actions:</p>
                    <ul className="mt-3 space-y-2">
                      <li><span className="font-mono font-semibold text-foreground">FEEDBACK</span> — send a note directly to the Coach Dean team. Use this to report a bug, share a suggestion, or tell us something Coach Dean got wrong.</li>
                      <li><span className="font-mono font-semibold text-foreground">MY PLAN</span> — get a link to your training plan dashboard, where you can see your full season schedule.</li>
                      <li><span className="font-mono font-semibold text-foreground">UNSUBSCRIBE</span> — get a link to cancel your subscription at any time.</li>
                      <li><span className="font-mono font-semibold text-foreground">STOP</span> — stop all messages immediately. You'll also receive a link to cancel billing. Text START to resume at any time.</li>
                    </ul>
                    <p className="mt-3">Everything else is just plain conversation — ask questions, report a run, tell Coach Dean your knee hurts. He handles it.</p>
                  </>
                ),
              },
              {
                q: "Is my data private?",
                a: "Your training data, pace information, and conversations with Coach Dean are used solely to power your coaching experience — nothing else. We don't sell your data or share it with third parties. If you connect Strava, that access is read-only and only used to pull your workout history into Coach Dean. You can request deletion of your data at any time by texting FEEDBACK: Delete my account.",
              },
            ].map(({ q, a }) => (
              <details key={q} className="group py-4">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-4 font-medium">
                  <span>{q}</span>
                  <span className="mt-0.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <div className="mt-3 text-sm leading-relaxed text-muted-foreground">{a}</div>
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
      </section>

      {/* Footer */}
      <footer className="border-t px-6 py-10 text-center text-sm text-muted-foreground">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-3">
          <p className="font-medium text-foreground">Coach Dean</p>
          <p>
            Questions or feedback?{" "}
            <a
              href="mailto:hello@coachdean.ai"
              className="underline hover:text-foreground"
            >
              hello@coachdean.ai
            </a>
          </p>
          <div className="flex gap-4 text-xs">
            <a href="/privacy" className="underline hover:text-foreground">Privacy Policy</a>
            <a href="/terms" className="underline hover:text-foreground">Terms of Service</a>
          </div>
          <p className="text-xs text-muted-foreground/70">
            &copy; {new Date().getFullYear()} CoachDean. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
