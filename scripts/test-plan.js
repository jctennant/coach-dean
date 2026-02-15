const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const systemPrompt = `You are Coach Dean, an expert running coach communicating via text message. You specialize in trail and ultra running and periodized training plans.

COMMUNICATION STYLE:
- Text message tone: concise, encouraging, knowledgeable
- Use specific paces, distances, and effort levels
- Be direct and actionable
- Use occasional emoji sparingly
- Keep it conversational but information-dense`;

const userMessage = `Here is a new athlete's Strava data and race calendar. Generate a structured training plan.

ATHLETE PROFILE:
- Name: Jake
- Location: Berkeley, CA
- Weight: 150 lbs
- Experience: Many years of running, 1,150 runs / 6,606 miles all-time on Strava
- Experienced ultra runner (completed 61-mile ultra April 2025)
- History of shin splints (October 2025, resolved)

RACE CALENDAR:
1. 30K trail race, southern Utah - end of March 2026 (~6 weeks out)
2. Half marathon - April 2026 (~8 weeks out)
3. 100K ultra - July 2026 (~5 months out)
4. Dipsea + Cirque Series steep trail races - July-September 2026

RECENT WEEKLY MILEAGE (last 12 weeks, all runs including trail):
- This week (partial, through Tue): 11.3 mi (2 runs)
- Last week (Feb 2-8): 27.7 mi (4 runs)
- Jan 26-Feb 1: 48.1 mi (7 runs, big week in Utah)
- Jan 19-25: 23.2 mi (4 runs)
- Jan 12-18: 12.4 mi (2 runs)
- Jan 5-11: 52.5 mi (5 runs, Patagonia adventure)
- Dec 29-Jan 4: 12.8 mi (2 runs)
- Dec 22-28: 19.2 mi (3 runs)
- Dec 15-21: 14.3 mi (2 runs)
- Dec 8-14: 18.2 mi (4 runs)
- Dec 1-7: 19.0 mi (5 runs)
- Nov 24-30: 30.5 mi (5 runs)

PACE DATA (from Strava):
- 5K PR: 5:34/mi (July 2025, road race)
- Fast road effort: 6:54/mi for 6.5 mi (Dec 2025)
- Interval sessions: 7:22-7:29/mi for 7-8 mi
- Easy road pace: 8:30-9:30/mi
- Trail/mountain pace: varies widely 9:00-15:00+/mi depending on terrain and vert
- Average HR across runs: 152 bpm
- Max avg HR seen: 170 bpm

NOTABLE RECENT RUNS:
- Feb 11: 7.0mi at 7:51/mi (lunch run)
- Feb 9: 4.3mi at 8:41/mi
- Feb 8: 8.0mi at 7:29/mi (TdMF intervals)
- Feb 7: 5.0mi at 9:36/mi (trail with mountain biker)
- Feb 5: 9.6mi at 13:38/mi (big vert trail, Khyv Peak sunset)
- Jan 31: 14.3mi at 14:17/mi (Kolob Canyon, Utah)
- Jan 28: 9.2mi at 9:10/mi (trail intervals)
- Sep 2025: 8.5mi at 7:29/mi (track workout)

WHAT TO INCLUDE:
1. Honest assessment of current fitness and readiness for the race calendar
2. Suggested training zones/paces based on the data
3. Week-by-week plan for the next 6 weeks through the 30K trail race
4. How to transition from 30K -> half marathon -> 100K build
5. Key workouts and their purpose
6. What needs to change about the volume inconsistency (swings from 12 to 52 mi/week)
7. Vert/elevation training recommendations for the trail races`;

async function main() {
  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  console.log(response.content[0].text);
}

main();
