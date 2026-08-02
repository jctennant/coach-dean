import { Suspense } from "react";
import { WaitlistForm } from "@/components/waitlist-form";
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
/*  Structured data (SEO / AEO)                                         */
/*  FAQPage + SoftwareApplication JSON-LD so search engines and AI       */
/*  answer engines can surface Coach Dean for injury/training queries.   */
/* ------------------------------------------------------------------ */

const FAQ_JSONLD = [
  {
    q: "Can Coach Dean actually prevent running injuries?",
    a: "Coach Dean catches the patterns that precede most running injuries — load spikes, declining aerobic efficiency, and grey-zone effort distribution — and flags them early so you can act conservatively. He's not a physio and can't diagnose, but he's the early warning system most runners are missing. When something flares up, he prescribes rehab exercises for common injuries like IT band syndrome, shin splints, plantar fasciitis, and hip flexor tightness, and swaps affected sessions for cross-training so your fitness doesn't evaporate while you recover.",
  },
  {
    q: "Can Coach Dean help me return to running after an injury?",
    a: "Yes. Coach Dean is built for runners coming back from injury or time off. He rebuilds your plan around a gradual return to load, prescribes the strengthening work your PT keeps recommending, and checks in after each run to make sure tissue is ready before you step volume back up.",
  },
  {
    q: "What are the most common causes of running injuries?",
    a: "Research consistently points to five factors: sudden spikes in running load (a long run well beyond what you've recently done), a previous injury in the last 12 months (the single strongest predictor), weak hips and core, chronically short sleep, and unstructured, ad-hoc training. Coach Dean is built around all five — he flags load spikes from Strava in real time, weighs your injury history, builds hip and core strength into your week, checks your sleep and recovery, and keeps your plan gradual and structured. The edge is holding all of it at once.",
  },
  {
    q: "I already use Runna or TrainingPeaks. Do I need Coach Dean?",
    a: "Yes — this is our most common use case. Runna or TrainingPeaks gives you the plan; Coach Dean gives you the intelligence layer on top of it: a coaching note after every run, load monitoring, and a direct line for training questions over text. Text him a PDF of your plan and he'll ingest it and reference it directly when giving feedback.",
  },
  {
    q: "What type of races can Coach Dean help me prepare for?",
    a: "Coach Dean can build training plans for 5Ks all the way up to ultramarathons, including half marathons, full marathons, and trail races. Not sure what distance is right for you? Tell Coach Dean where you're at and he'll help you figure it out.",
  },
  {
    q: "Do I need Strava or a GPS watch?",
    a: "No — all you need is a phone number. But connecting Strava unlocks the best version of Coach Dean: he pulls your full activity history to build a real picture of your fitness before your first plan is written, and sends coaching feedback within minutes of every run finishing. Without Strava, he asks for a recent race time or your comfortable conversational pace and calculates your training zones from there.",
  },
  {
    q: "Does Coach Dean include strength training?",
    a: "Yes. Coach Dean weaves targeted strength and mobility work into your week — hip, glute, and calf work that protects your knees, IT band, and achilles — and holds you accountable to it instead of leaving it as something you know you should do. When you're injured, the strengthening routine is built directly into your return-to-running progression.",
  },
  {
    q: "What happens if I miss a workout or need to take a week off?",
    a: "Just tell Coach Dean — text him like you'd text a coach. Whether you missed a run, got sick, or needed a mental break, he adjusts your upcoming week and rebuilds the ramp so you ease back in instead of cramming the missed miles, keeping you on track toward your goal race.",
  },
  {
    q: "How much does Coach Dean cost?",
    a: "It's free for the first 7 days, then $15/month. Cancel anytime with no penalties.",
  },
  {
    q: "What training philosophy does Coach Dean follow?",
    a: "Polarized 80/20 training, Lydiard-style aerobic base building, and Jack Daniels VDOT pacing, with targeted strength and mobility work woven in. The specifics are always adapted to your fitness, schedule, and goal race.",
  },
];

const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: "Coach Dean",
      applicationCategory: "HealthApplication",
      operatingSystem: "iOS, Android, Web",
      url: "https://coachdean.ai",
      description:
        "An AI running coach that connects to Strava and coaches you over text — flagging injury risk early, prescribing rehab and strength work, and rebuilding your plan around injuries or missed time so you reach race day healthy.",
      offers: {
        "@type": "Offer",
        price: "15.00",
        priceCurrency: "USD",
        description: "Free for the first 7 days, then $15/month. Cancel anytime.",
      },
    },
    {
      "@type": "FAQPage",
      mainEntity: FAQ_JSONLD.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    },
  ],
};

/* ------------------------------------------------------------------ */
/*  Evidence-based injury-prevention levers                            */
/*  Each maps a research finding to a real Coach Dean capability.       */
/* ------------------------------------------------------------------ */

const LEVERS = [
  {
    num: "01",
    value: "+128%",
    label: "injury risk from one overlong run",
    lever: "Sudden load spikes",
    finding:
      "In the Garmin-RUNSAFE study of 5,205 runners, a single run more than 100% longer than your longest in the past 30 days doubled injury risk. Even a 10–30% jump raised it 64%.",
    coachDean:
      "reads every run from Strava and flags a load spike the moment it happens — before you stack another hard day on top of it.",
    source: "Garmin-RUNSAFE study · 5,205 runners",
  },
  {
    num: "02",
    value: "2–6×",
    label: "higher risk after a recent injury",
    lever: "A recent injury",
    finding:
      "A running injury in the last 12 months is the single strongest predictor of the next one. Nearly half of new injuries strike within two weeks of an earlier problem — often from rushing back too soon.",
    coachDean:
      "asks about your injury history before writing a single workout, and stays more conservative with your load because of it.",
    source: "Epidemiological reviews of running-related injury",
  },
  {
    num: "03",
    value: "−34%",
    label: "fewer injuries with hip & core work",
    lever: "Hip & core strength",
    finding:
      "In a 2024 randomized controlled trial, a guided hip-and-core routine cut lower-body injuries 34% and substantial overuse injuries 52% versus stretching — but only when someone kept runners accountable to it.",
    coachDean:
      "builds hip, glute, and core work into your week and checks that you're actually doing it — the accountability the research says is the whole point.",
    source: "Run RCT · Leppänen et al., BJSM 2024",
  },
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col" style={{ minHeight: "100vh" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />
      <Navbar />

      {/* Hero */}
      <section id="get-started" className="flex items-center px-6" style={{ minHeight: "100vh", paddingTop: "calc(4rem + 48px)", paddingBottom: "48px" }}>
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-12 md:flex-row md:items-center md:gap-16">
          {/* Text + form */}
          <div className="flex flex-1 flex-col items-center gap-6 text-center md:items-start md:text-left" style={{ maxWidth: 480 }}>
            <h1 className="font-serif text-4xl font-normal leading-tight tracking-tight md:text-5xl lg:text-5xl">
              An expert running coach who keeps you healthy.
            </h1>
            <p className="text-lg" style={{ color: "#4a4a4a" }}>
              Coach Dean reads every run you do and texts you back like a coach who&apos;s actually paying attention — catching the small stuff before it sidelines you.
            </p>
            <p className="text-sm font-medium text-[#1a5c35]">Join the waitlist — spots opening soon.</p>
            <Suspense>
              <WaitlistForm />
            </Suspense>
          </div>
          {/* iPhone mockup */}
          <div className="flex flex-1 justify-center">
            <IMessageMockup />
          </div>
        </div>
      </section>

      <RaceMarquee />

      {/* How it works — 3 steps */}
      <section className="border-t px-6 py-14 md:py-20">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-10 text-center font-serif text-2xl font-normal md:text-3xl">
            How it works
          </h2>

          <div className="grid gap-4 md:grid-cols-3 md:gap-6">
            {[
              { step: "01", label: "Connect Strava", sub: "One tap. Coach Dean reads your full history and builds your load and injury risk profile from day one." },
              { step: "02", label: "Dean watches every run for warning signs", sub: "Coaching note within minutes. Load spikes, grey-zone effort, form cues. Dean flags what matters before it becomes a problem. Mention a sore knee or missed run and your plan adjusts." },
              { step: "03", label: "Train through the whole season", sub: "Not in cycles of training hard, getting hurt, and starting over. Stay consistent, stay healthy, and actually reach your goal." },
            ].map(({ step, label, sub }) => (
              <div key={step} className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <span
                  className="font-mono text-3xl font-bold leading-none"
                  style={{ color: "#d1e0d7" }}
                >
                  {step}
                </span>
                <div>
                  <p className="font-semibold text-gray-900 leading-snug">{label}</p>
                  <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Research — the five evidence-based injury-prevention levers */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-4xl">
          <div className="mb-12 text-center">
            <p className="mb-3 text-sm uppercase tracking-widest text-muted-foreground">Backed by the research</p>
            <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
              The three things that actually keep runners healthy.
            </h2>
            <p className="mx-auto max-w-xl leading-relaxed text-muted-foreground">
              Most running injuries trace back to the same handful of factors. Coach Dean is built around the three with the strongest evidence behind them.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            {LEVERS.map(({ num, value, label, lever, finding, coachDean, source }) => (
              <div key={num} className="rounded-2xl border border-gray-200 bg-white p-6 md:p-7">
                <div className="flex flex-col gap-5 md:flex-row md:gap-8">
                  {/* Stat */}
                  <div className="flex shrink-0 items-baseline gap-3 md:w-44 md:flex-col md:items-start md:gap-1">
                    <span className="font-mono text-xs text-gray-300">{num}</span>
                    <span className="font-serif text-4xl leading-none text-[#1a5c35]">{value}</span>
                    <span className="text-xs leading-snug text-muted-foreground">{label}</span>
                  </div>
                  {/* Body */}
                  <div className="flex-1">
                    <p className="font-semibold text-gray-900">{lever}</p>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{finding}</p>
                    <p className="mt-3 text-sm leading-relaxed text-gray-800">
                      <span className="font-medium text-[#1a5c35]">Coach Dean</span> {coachDean}
                    </p>
                    <p className="mt-3 text-xs text-gray-400">{source}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-relaxed text-muted-foreground">
            None of these work in isolation. A runner three weeks off an injury who spikes their long run on Saturday is in a completely different place than someone fresh and healthy doing the exact same run. Coach Dean holds all of it at once — that&apos;s the edge.
          </p>
        </div>
      </section>

      {/* Insights section — concrete Dean message examples */}
      <section className="border-t bg-muted/40 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-12 text-center">
            <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
              Prevention. Adaptation. Recovery.
            </h2>
            <p className="mx-auto max-w-xl leading-relaxed text-muted-foreground">
              Whether you&apos;re trying to stay healthy, managing something that flared up, or rebuilding after time off. Coach Dean handles all three.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {["IT band syndrome", "shin splints", "plantar fasciitis", "stress reactions", "hip flexor pain", "achilles tendinopathy", "runner's knee", "hamstring strains"].map((injury) => (
                <span key={injury} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-500">{injury}</span>
              ))}
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Insight 1 — Injury sounding board (shin splints) */}
            <InsightCard
              context="After today's run"
              tag="Injury prevention"
              tagColor="#dc2626"
              messages={[
                { from: "user", text: "Left shin has been a bit sore the last two runs — not sharp, just there." },
                { from: "dean", text: "Classic early-stage medial shin stress. Usually means your mileage ramped a bit faster than your bone remodeling can keep up with. Ice it tonight, skip tomorrow's run, and I'll swap it for a pool session or bike day. We'll ease back in over 4–5 days. If it sharpens at all, ping me before you run again." },
              ]}
            />

            {/* Insight 2 — Return to run */}
            <InsightCard
              context="After 2 weeks off with IT band pain"
              tag="Return to run"
              tagColor="#f97316"
              messages={[
                { from: "user", text: "Knee felt fine on my test run yesterday. Safe to get back to normal?" },
                { from: "dean", text: "Good sign, but one pain-free run doesn't mean the tissue is ready for full load. Three easy 20-minute runs this week, flat routes only, no tempo. If all three feel clean, we step back up next week. I'll check in after each one and have your IT band strengthening routine ready to go." },
              ]}
            />

            {/* Insight 3 — Training calibration */}
            <InsightCard
              context="After Wednesday's 5.8mi run · 9:12/mi · 148ft gain"
              tag="Load monitoring"
              tagColor="#9333ea"
              messages={[
                { from: "dean", text: "Your last four runs have all landed at moderate effort. 148bpm today puts you right in the grey zone again. No real easy days, no real hard day. That pattern builds fatigue without building fitness, and it's a common injury setup. Try a genuinely easy 40 min tomorrow and Thursday's workout will land a lot better." },
              ]}
            />

            {/* Insight 4 — Real-time adaptation */}
            <InsightCard
              context="Tuesday morning"
              tag="Adapts to your life"
              tagColor="#0891b2"
              messages={[
                { from: "user", text: "Just did a heavy leg day — squats and deadlifts. Should I still run my 6 tonight?" },
                { from: "dean", text: "Skip the 6 tonight. Running heavy after that lift is how achilles and hamstring stuff sneaks in. Move tonight to a 30-min easy spin or full rest, shift the 6 to Wednesday, and bump Thursday's tempo to Friday so the legs get a real recovery window. Plan still works." },
              ]}
            />

            {/* Insight 5 — Strength accountability */}
            <InsightCard
              context="Tuesday · intervals Thursday"
              tag="Strength & mobility"
              tagColor="#1a5c35"
              messages={[
                { from: "dean", text: "You've got intervals Thursday, so today's your window for the strength work that actually protects your knees. 15 min: single-leg squats, hip bridges, calf raises, and the side planks for your IT band. I'll keep this in your week every Tuesday so it doesn't slip — it's the stuff that keeps you running." },
                { from: "user", text: "Honestly the part I always skip. Thanks for the nudge." },
              ]}
            />

            {/* Insight 6 — Plan rebuild after missed time */}
            <InsightCard
              context="After 9 days off · head cold"
              tag="Plan rebuild"
              tagColor="#2563eb"
              messages={[
                { from: "user", text: "Finally feeling better. I lost a week and a half — am I behind?" },
                { from: "dean", text: "Not behind, just adjusting. I've rebuilt the next two weeks so you ease back in instead of jumping to where the old plan had you. Easy 3 tomorrow, then we rebuild volume gradually. Your race date still works — I recalculated the ramp. No need to cram the missed miles." },
              ]}
            />
          </div>
        </div>
      </section>

      {/* Comparison — directly below insights with simple bridge */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-12 text-center">
            <p className="text-sm uppercase tracking-widest text-muted-foreground mb-3">Works alongside the tools you already use</p>
            <h2 className="mb-4 font-serif text-2xl font-normal md:text-3xl">
              The missing layer between your plan and your potential.
            </h2>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {/* Training without coaching */}
            <div className="rounded-2xl border border-gray-200 bg-white p-6 flex flex-col gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Training without coaching</p>
                <p className="font-serif text-lg font-normal text-gray-700">Apps alone</p>
              </div>
              <ul className="text-sm leading-relaxed text-muted-foreground flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Plan tells you what to do. Nothing explains why.</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> &ldquo;Workout Complete&rdquo; is the only feedback you get</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Load patterns go unnoticed until you&apos;re already sidelined</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> Injury questions go to Google</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> No one rebuilds your plan when you miss two weeks</li>
              </ul>
            </div>

            {/* Coach Dean — featured */}
            <div className="rounded-2xl bg-gray-900 p-6 flex flex-col gap-4 text-white md:-mt-4 md:-mb-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">The intelligence layer</p>
                <p className="font-serif text-lg font-normal">Coach Dean</p>
              </div>
              <ul className="text-sm leading-relaxed text-gray-300 flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Flags load spikes and grey-zone patterns before they become injuries</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Prescribes rehab exercises and cross-training so you stay fit while you heal</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Rebuilds your plan around injuries, illness, or missed weeks</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Works alongside Runna, TrainingPeaks, or any plan you already have</li>
                <li className="flex gap-2"><span className="text-green-400 mt-0.5">✓</span> Explains what your HR, pace, and cadence actually mean</li>
              </ul>
              <div>
                <p className="text-sm font-medium text-gray-300">Free to start, then $15 / month</p>
                <p className="text-xs text-gray-500 mt-0.5">Cancel anytime, no friction</p>
              </div>
            </div>

            {/* Human coach */}
            <div className="rounded-2xl border border-gray-200 bg-white p-6 flex flex-col gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Private coach</p>
                <p className="font-serif text-lg font-normal text-gray-700">The gold standard</p>
              </div>
              <ul className="text-sm leading-relaxed text-muted-foreground flex-1 space-y-2">
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Weekly adaptation; requires a call to change anything</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Detailed feedback, but often delayed</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">~</span> Scheduled calls &amp; email only</li>
                <li className="flex gap-2"><span className="text-gray-300 mt-0.5">✗</span> High friction: schedules, logins, check-ins</li>
              </ul>
              <p className="text-sm font-medium text-gray-500">$150–300 / month</p>
            </div>
          </div>
        </div>
      </section>

      {/* Insights — what Coach Dean delivers after every run */}
      <section className="border-t bg-muted/40 px-6 py-14 md:py-20">
        <div className="mx-auto max-w-4xl">
          <div className="mb-10 text-center">
            <p className="text-sm uppercase tracking-widest text-muted-foreground mb-3">What he looks at, every run</p>
            <h2 className="font-serif text-2xl font-normal md:text-3xl">
              Six lenses on every run.
            </h2>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:gap-x-8 md:gap-y-8">
            {[
              {
                title: "Load and injury risk",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="3" y1="20" x2="21" y2="20" />
                    <rect x="4" y="15" width="2.5" height="5" />
                    <rect x="8" y="12" width="2.5" height="8" />
                    <rect x="12" y="8" width="2.5" height="12" />
                    <rect x="16" y="5" width="2.5" height="15" fill="currentColor" />
                  </svg>
                ),
              },
              {
                title: "Aerobic efficiency",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="3,17 8,12 12,14 16,8 21,5" />
                    <polyline points="17,5 21,5 21,9" />
                  </svg>
                ),
              },
              {
                title: "Pacing and splits",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="3" y1="20" x2="21" y2="20" />
                    <rect x="4.5" y="13" width="3" height="7" />
                    <rect x="9.5" y="9" width="3" height="11" />
                    <rect x="14.5" y="11" width="3" height="9" />
                  </svg>
                ),
              },
              {
                title: "Cadence and form",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="5" r="2" />
                    <path d="M12 7 L10 12 L7 14" />
                    <path d="M12 7 L14 12 L17 14" />
                    <path d="M10 12 L9 18" />
                    <path d="M14 12 L15 18" />
                  </svg>
                ),
              },
              {
                title: "Wins and milestones",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3 L13.9 8.6 L19.8 8.6 L15 12.1 L16.9 17.7 L12 14.2 L7.1 17.7 L9 12.1 L4.2 8.6 L10.1 8.6 Z" />
                  </svg>
                ),
              },
              {
                title: "How this fits your goal",
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="8" />
                    <circle cx="12" cy="12" r="3.5" />
                    <circle cx="12" cy="12" r="0.5" fill="currentColor" />
                  </svg>
                ),
              },
            ].map(({ title, icon }) => (
              <div key={title} className="flex flex-col items-center gap-3 text-center">
                <div className="h-10 w-10 text-[#1a5c35]">{icon}</div>
                <p className="text-sm font-semibold text-gray-900 leading-snug">{title}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="border-t px-6 py-16 md:py-24">
        <div className="mx-auto max-w-4xl text-center">
          <p className="mb-8 text-xs uppercase tracking-widest text-muted-foreground">From the athletes</p>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            {[
              {
                quote: "Coach Dean made all the difference in my most recent ultra race. He helped me strategize mileage build, nutrition, apparel, and so much more — and kept me organized and motivated throughout.",
                name: "Luke S.",
                detail: "Ultramarathon finisher",
              },
              {
                quote: "I'm training for a half marathon and Coach Dean has truly been so helpful! He's kept me motivated and helped to work in cross training and proper pacing. It feels like I'm talking to an actual coach with a consistent personality.",
                name: "Madie D.",
                detail: "Training for a half marathon",
              },
            ].map(({ quote, name, detail }) => (
              <figure key={name} className="flex flex-col items-center gap-4">
                <span className="font-serif text-5xl leading-none text-gray-200" aria-hidden="true">&ldquo;</span>
                <blockquote className="font-serif text-lg font-normal leading-relaxed text-gray-800 md:text-xl" style={{ marginTop: "-1.25rem" }}>
                  {quote}
                </blockquote>
                <figcaption className="flex items-center gap-3">
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      background: "#1a5c35",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ fontFamily: SYS_FONT, fontSize: 12, fontWeight: 600, color: "#ffffff" }}>
                      {name.charAt(0)}
                    </span>
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-gray-900 leading-tight">{name}</p>
                    <p className="text-xs text-muted-foreground leading-tight">{detail}</p>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t bg-muted/40 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-10 text-center font-serif text-2xl font-normal md:text-3xl">
            Frequently asked questions
          </h2>
          <div className="divide-y">
            {[
              {
                q: "I already use Runna or TrainingPeaks. Do I need Coach Dean?",
                a: (
                  <>
                    <p>Yes, and this is actually our most common use case. Runna gives you the plan. Coach Dean gives you the intelligence layer on top of it: a coaching note after every run, load monitoring, and a direct line for training questions. Keep your Runna structure. Coach Dean adds what no app does.</p>
                    <p className="mt-3">Text Coach Dean a PDF of your plan and he&apos;ll ingest it automatically, then reference it directly when giving you feedback. So instead of &ldquo;you ran 8:45 pace,&rdquo; you get &ldquo;that was your recovery day, 8:45 with 140bpm HR is exactly right, your legs should feel fresher by Thursday.&rdquo;</p>
                  </>
                ),
              },
              {
                q: "Can Coach Dean actually prevent injuries?",
                a: (
                  <>
                    <p>Coach Dean is genuinely good at catching the patterns that precede most running injuries: load spikes, declining aerobic efficiency, and grey-zone effort distribution. He flags them early so you can act conservatively. He&apos;s not a physio and can&apos;t diagnose anything, but he&apos;s the early warning system most runners are missing.</p>
                    <p className="mt-3">When something does flare up, Coach Dean will prescribe specific rehab exercises for common running injuries (IT band, shin splints, plantar fasciitis, hip flexor tightness) and swap affected sessions for cross-training alternatives like pool running, cycling, or the elliptical so your fitness doesn&apos;t evaporate while you recover. The goal is to stay in training, not just to rest and hope.</p>
                  </>
                ),
              },
              {
                q: "What are the most common causes of running injuries?",
                a: (
                  <>
                    <p>The research keeps landing on the same handful of factors: a sudden spike in running load (a long run well beyond what you&apos;ve recently done), a previous injury in the last 12 months, weak hips and core, chronically short sleep, and unstructured, ad-hoc training.</p>
                    <p className="mt-3">Coach Dean is built around all five. He watches your load on Strava and flags spikes in real time, weighs your injury history when setting your plan, builds hip and core strength work into your week, checks in on your sleep and recovery, and keeps your training gradual and structured. The edge is holding all of it at once: the same big Saturday long run is a very different risk if you&apos;re also under-slept and three weeks off an injury.</p>
                  </>
                ),
              },
              {
                q: "Can Coach Dean help me if I'm not training for a specific race?",
                a: "Yes, especially if you're coming back from injury or trying to stay consistent through a high-mileage stretch. That said, Coach Dean is at his best with a goal on the calendar. If you don't have one yet, tell him where you're at and he'll help you pick something realistic.",
              },
              {
                q: "What type of races can Coach Dean help me prepare for?",
                a: "Coach Dean can build training plans for 5Ks all the way up to ultramarathons, including half marathons, full marathons, and trail races. Not sure what distance is right for you? Tell Coach Dean where you're at and he'll help you figure it out.",
              },
              {
                q: "Do I need Strava or a GPS watch?",
                a: (
                  <>
                    <p>Technically no, all you need is a phone number. But connecting Strava unlocks the best version of Coach Dean. He pulls your full activity history (recent paces, long run efforts, workout splits) to build a real picture of your fitness before your first plan is written, and sends you coaching feedback within minutes of every run finishing. It&apos;s the feature testers have found most valuable.</p>
                    <p className="mt-3">If you don&apos;t use Strava, Coach Dean asks for a recent race time or your comfortable conversational pace and calculates your training zones from there using the same pace formulas elite coaches use. Those zones get refined over time as you share feedback over text.</p>
                  </>
                ),
              },
              {
                q: "What kinds of insights does Coach Dean give me after a run?",
                a: (
                  <>
                    <p>Six different lenses, every time your run syncs from Strava. Coach Dean weighs all of them and surfaces whichever one is most worth saying that day:</p>
                    <ul className="mt-3 space-y-2 list-disc pl-5">
                      <li><span className="font-semibold text-foreground">Aerobic efficiency.</span> Pace at HR over time, so you can see fitness moving in the data, not just on race day.</li>
                      <li><span className="font-semibold text-foreground">Pacing and splits.</span> First-half vs second-half, fade detection, whether you went out too hot.</li>
                      <li><span className="font-semibold text-foreground">Effort zone audit.</span> Catches the grey-zone trap where every run lives at moderate effort and nothing moves forward.</li>
                      <li><span className="font-semibold text-foreground">Load monitoring.</span> This week vs your four-week average, week-over-week changes, milestone runs (longest in 30 days, YTD totals).</li>
                      <li><span className="font-semibold text-foreground">Cadence and form trends.</span> 10-run cadence average, with cues if it&apos;s drifting in a direction worth nudging.</li>
                      <li><span className="font-semibold text-foreground">Workout-vs-intent check.</span> Did today&apos;s tempo land in tempo zone? Did the long run actually stay easy? Coach Dean compares execution to the prescribed effort.</li>
                    </ul>
                  </>
                ),
              },
              {
                q: "Does Coach Dean build me a training plan?",
                a: "Yes, from scratch, based on your goal, current fitness, and schedule. But the plan is a starting point, not the product. The real value is what happens after every run.",
              },
              {
                q: "How much does Coach Dean cost?",
                a: "It's free for the first 7 days. Cancel with no penalties. After that, $15/mo.",
              },
              {
                q: "What training philosophy does Coach Dean follow?",
                a: "Polarized 80/20 training, Lydiard-style aerobic base building, and Jack Daniels VDOT pacing, with targeted strength and mobility work woven in. The specifics are always adapted to your fitness, schedule, and goal race.",
              },
              {
                q: "What happens if I miss a workout or need to take a week off?",
                a: "Just tell Coach Dean. Seriously, text him like you'd text a coach. Whether you missed a run, got sick, or needed a mental break, Coach Dean will adjust your upcoming week to account for it and keep you on track toward your goal. Life happens, and a good coach works around it rather than ignoring it.",
              },
              {
                q: "Are there any special commands I can text Coach Dean?",
                a: (
                  <>
                    <p>Beyond just chatting, a few keywords trigger specific actions:</p>
                    <ul className="mt-3 space-y-2">
                      <li><span className="font-mono font-semibold text-foreground">FEEDBACK</span>: send a note directly to the Coach Dean team. Use this to report a bug, share a suggestion, or tell us something Coach Dean got wrong.</li>
                      <li><span className="font-mono font-semibold text-foreground">STRAVA CONNECTION</span>: get a link to update your Strava permissions, including adding or removing the coaching notes that appear on each activity.</li>
                      <li><span className="font-mono font-semibold text-foreground">UPDATE PLAN</span>: confirms a full plan rebuild after Coach Dean proposes one. Useful when your goal, schedule, or fitness has shifted.</li>
                      <li><span className="font-mono font-semibold text-foreground">UNSUBSCRIBE</span>: get a link to cancel your subscription at any time.</li>
                      <li><span className="font-mono font-semibold text-foreground">STOP</span>: stop all messages immediately. You&apos;ll also receive a link to cancel billing. Text START to resume at any time.</li>
                    </ul>
                    <p className="mt-3">Everything else is just plain conversation. Ask questions, report a run, tell Coach Dean your knee hurts. He handles it.</p>
                  </>
                ),
              },
              {
                q: "Is my data private?",
                a: "Your training data, pace information, and conversations with Coach Dean are used solely to power your coaching experience, nothing else. We don't sell your data or share it with third parties. If you connect Strava, that access is only used to pull your workout history into Coach Dean so it can text you a coaching note after each run. You can request deletion of your data at any time by texting FEEDBACK: Delete my account.",
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
      <section className="flex flex-col items-center gap-6 border-t px-6 py-16 text-center md:py-24">
        <h2 className="max-w-xl font-serif text-2xl font-normal md:text-3xl">
          Stop losing weeks to injury.
        </h2>
        <p className="max-w-md text-muted-foreground leading-relaxed">
          Join the waitlist and we&apos;ll text you when spots open up.
        </p>
        <Suspense>
          <WaitlistForm centered />
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
