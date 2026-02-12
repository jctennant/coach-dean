# AI Running Coach — Project Spec

## Overview

An AI-powered running coach that connects to a user's Strava account and communicates entirely via SMS. The coach proactively sends workout plans and post-run feedback, and reactively responds to user questions/updates. Think of it as a $150/month running coach in your text messages for free.

The MVP targets half marathon training but the architecture should support any distance/goal.

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | **Next.js 14+ (App Router)** | TypeScript, deployed on Vercel |
| Database | **Supabase (Postgres)** | User profiles, training state, conversation history |
| Messaging | **Twilio SMS** | Inbound + outbound SMS |
| Fitness Data | **Strava API v3** | OAuth 2.0, webhooks for new activities |
| AI | **Anthropic Claude API** | Coaching logic, conversation, workout generation |
| Scheduling | **Vercel Cron Jobs** | Morning workout reminders |
| Auth | **Strava OAuth 2.0** | Only auth mechanism needed for MVP |

---

## User Journey

### 1. Onboarding (Web — only time user touches the web app)

```
User visits landing page
  → Enters phone number
  → Clicks "Connect Strava" → Strava OAuth flow
  → Redirected back to app
  → Enters basic info:
      - Goal race (e.g., half marathon)
      - Race date (if applicable)
      - Current fitness level (beginner / intermediate / advanced)
      - Days per week available to train (3-6)
      - Any injuries or constraints (free text, optional)
  → Receives first SMS: "Hey [name]! I'm your AI running coach. I've pulled your recent Strava data and built your first week of training. Here's tomorrow's workout: ..."
```

After onboarding, **everything happens via SMS**. The user should never need to open the web app again (though they can revisit to update settings or disconnect).

### 2. Proactive Messages (AI → User)

The coach sends messages at two key moments:

#### Morning Workout Plan (daily, ~7am user local time)
Triggered by a Vercel cron job. The AI looks at:
- Today's planned workout from the training block
- Yesterday's activity (or lack thereof)
- Accumulated fatigue / weekly mileage so far
- Any recent messages from the user ("my knee is sore")

Example outbound SMS:
> "Morning! Today's workout: 6mi easy run @ 9:30-10:00/mi pace. Keep your HR under 150. You've got 14mi on the week so far — right on track. Let me know how it goes 👟"

#### Post-Run Feedback (triggered by Strava webhook)
When a new activity is created/updated on Strava, the webhook fires and the AI analyzes the completed workout.

Example outbound SMS:
> "Nice work on today's 6.2mi! Avg pace 9:42 is right in zone. HR averaged 145 which is solid for easy effort. One thing — your cadence dropped in the last mile (162 → 155), which sometimes means fatigue. Make sure you're fueling well tonight. Tomorrow is a rest day."

### 3. Reactive Messages (User → AI)

The user can text the coach anytime. Examples:
- "Can I swap today's run to tomorrow? I have a work thing."
- "My left shin has been bothering me the last two runs."
- "I ran a 5K race this weekend in 24:30, can you update my paces?"
- "Am I on track for a sub-2:00 half?"
- "What should I eat before my long run tomorrow?"

The AI responds conversationally, updates the training plan as needed, and logs any relevant context (injuries, schedule changes) to the user's training state.

---

## Core Data Model

### `users`
```sql
id              UUID PRIMARY KEY
phone_number    TEXT UNIQUE NOT NULL
strava_athlete_id BIGINT UNIQUE
strava_access_token TEXT
strava_refresh_token TEXT
strava_token_expires_at TIMESTAMP
name            TEXT
timezone        TEXT DEFAULT 'America/New_York'
created_at      TIMESTAMP DEFAULT now()
```

### `training_profiles`
```sql
id              UUID PRIMARY KEY
user_id         UUID REFERENCES users(id)
goal            TEXT  -- e.g., 'half_marathon'
race_date       DATE
fitness_level   TEXT  -- 'beginner', 'intermediate', 'advanced'
days_per_week   INT
constraints     TEXT  -- free text: injuries, schedule notes
current_easy_pace TEXT -- e.g., '9:30-10:00'
current_tempo_pace TEXT
current_interval_pace TEXT
updated_at      TIMESTAMP DEFAULT now()
```

### `training_state`
This is the key table — it maintains the AI's "memory" of where the user is in their plan so the LLM doesn't have to reconstruct it every time.

```sql
id              UUID PRIMARY KEY
user_id         UUID REFERENCES users(id)
current_week    INT  -- week number in the training block
current_phase   TEXT -- 'base', 'build', 'peak', 'taper'
weekly_mileage_target FLOAT
long_run_target FLOAT
week_mileage_so_far FLOAT
last_activity_date DATE
last_activity_summary JSONB -- compact summary of last workout
plan_adjustments TEXT -- notes from recent conversations ("user has shin soreness, reduce volume 10%")
updated_at      TIMESTAMP DEFAULT now()
```

### `conversations`
```sql
id              UUID PRIMARY KEY
user_id         UUID REFERENCES users(id)
role            TEXT  -- 'user', 'assistant', 'system'
content         TEXT
message_type    TEXT  -- 'morning_plan', 'post_run', 'user_message', 'coach_response'
strava_activity_id BIGINT -- if this message was triggered by an activity
created_at      TIMESTAMP DEFAULT now()
```

### `activities`
Cache of Strava activity data so we don't re-fetch constantly.

```sql
id              UUID PRIMARY KEY
user_id         UUID REFERENCES users(id)
strava_activity_id BIGINT UNIQUE
activity_type   TEXT
distance_meters FLOAT
moving_time_seconds INT
elapsed_time_seconds INT
average_heartrate FLOAT
max_heartrate   FLOAT
average_cadence FLOAT
average_pace    TEXT -- computed, stored for convenience
elevation_gain  FLOAT
suffer_score    INT
gear_id         TEXT
gear_name       TEXT
start_date      TIMESTAMP
summary         JSONB -- any additional data worth keeping
created_at      TIMESTAMP DEFAULT now()
```

---

## API Routes

### Strava Integration
- `GET /api/auth/strava` — Initiates Strava OAuth flow
- `GET /api/auth/strava/callback` — Handles OAuth callback, stores tokens
- `POST /api/webhooks/strava` — Receives Strava webhook events (activity create/update/delete)
- `GET /api/webhooks/strava` — Strava webhook verification (GET challenge)

### Twilio Integration
- `POST /api/webhooks/twilio` — Receives inbound SMS from users

### Cron Jobs
- `GET /api/cron/morning-workout` — Triggered daily, sends morning plans to all active users

### Internal
- `POST /api/coach/respond` — Core function: given a user + trigger (activity, message, cron), generates and sends a coaching response

---

## Key Implementation Details

### Strava OAuth & Token Refresh
- Request scopes: `read,activity:read_all`
- Access tokens expire every 6 hours — implement automatic refresh using the stored refresh token before any API call
- On token refresh, update `strava_access_token` and `strava_token_expires_at` in the database

### Strava Webhook Setup
- Register a webhook subscription pointing to `/api/webhooks/strava`
- On `activity.create` events: fetch the full activity details via `GET /activities/{id}`, store in `activities` table, trigger post-run coaching response
- Handle `athlete.deauthorize` events to clean up user data

### Strava Data to Fetch Per Activity
```
GET /api/v3/activities/{id}
```
Key fields: distance, moving_time, elapsed_time, average_heartrate, max_heartrate, average_cadence, elev_high, elev_low, total_elevation_gain, suffer_score, gear.name, splits_metric (per-km or per-mile splits), laps

### Twilio SMS Flow
- Inbound: Twilio POSTs to `/api/webhooks/twilio` with `Body` (message text) and `From` (phone number)
- Look up user by phone number
- Pass message + user context to coaching AI
- Outbound: Use Twilio REST API to send SMS from our Twilio number
- Keep messages under 1600 chars (SMS limit). If longer, the AI should summarize or split across messages.

### AI Coaching Logic

The core coaching function receives:
1. **Trigger type**: `morning_plan`, `post_run`, or `user_message`
2. **User context**: training profile, current training state, recent conversation history (last 10-15 messages)
3. **Activity data** (if post_run): full activity details from Strava

It constructs a system prompt that includes:

```
You are an expert running coach communicating via text message. You are coaching {name} for a {goal} on {race_date}.

TRAINING PHILOSOPHY:
- Follow periodized training: base → build → peak → taper
- 80/20 rule: ~80% easy effort, ~20% quality workouts
- Progressive overload: increase weekly mileage by no more than 10%/week
- Every 4th week is a recovery week (reduce volume 25-30%)
- Long runs progress by ~1 mile per week
- Quality workouts: tempo runs, intervals, race pace work (introduced in build phase)

CURRENT STATE:
- Week {current_week} of training, phase: {current_phase}
- Weekly mileage target: {weekly_mileage_target} mi
- Mileage so far this week: {week_mileage_so_far} mi
- Current paces: Easy {easy_pace}, Tempo {tempo_pace}, Interval {interval_pace}
- Last activity: {last_activity_summary}
- Active adjustments: {plan_adjustments}

COMMUNICATION STYLE:
- Text message tone: concise, encouraging, knowledgeable
- Use numbers and paces specifically — don't be vague
- Flag potential injury/overtraining signals directly
- It's okay to tell the user to rest or scale back
- Keep messages under 300 words
- Use occasional emoji sparingly (👟🏃‍♂️💪)

RECENT CONVERSATION:
{last 10-15 messages}
```

After the AI generates a response:
1. Send via Twilio SMS
2. Store the conversation in the `conversations` table
3. If the AI's response implies a plan change (rest day, adjusted paces, etc.), update `training_state`

### Training Plan Generation
Rather than pre-generating an entire 12-16 week plan, the AI should:
- Know what phase/week the user is in
- Generate the next 7 days of workouts at a time (stored as a JSON field or generated on-the-fly each morning)
- Adjust dynamically based on actual performance vs. plan
- This keeps the plan flexible and responsive

---

## Environment Variables

```
# Strava
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_WEBHOOK_VERIFY_TOKEN=  # random string you set for webhook verification

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=  # your Twilio number

# Anthropic
ANTHROPIC_API_KEY=

# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# App
NEXT_PUBLIC_APP_URL=  # e.g., https://your-app.vercel.app
```

---

## MVP Scope — What to Build First

### Phase 1: Core loop (build this first)
1. Landing page with phone number input + Strava OAuth
2. Strava webhook listener that stores activities
3. Post-run AI feedback via SMS (this is the highest-value feature)
4. Inbound SMS → AI response (reactive coaching)

### Phase 2: Proactive coaching
5. Morning workout SMS via cron job
6. Training state tracking (week/phase progression)
7. Dynamic pace adjustment based on recent performance

### Phase 3: Polish
8. Onboarding flow (goal, race date, fitness level)
9. Settings page (update goal, disconnect Strava, change phone number)
10. Conversation history view on web

---

## External Account Setup Required

Before coding, you'll need:
1. **Strava API Application**: Create at https://www.strava.com/settings/api — set callback domain to `localhost` for dev, then your Vercel domain for prod
2. **Twilio Account**: Sign up, get a phone number with SMS capability, note Account SID + Auth Token
3. **Anthropic API Key**: From https://console.anthropic.com
4. **Supabase Project**: Create a new project, run the SQL migrations for the tables above
5. **Vercel Project**: Connect your repo, add all environment variables

---

## Notes & Considerations

- **Strava Rate Limits**: 200 requests per 15 minutes, 2,000 per day. For MVP with a handful of users this is fine. At scale, be smart about caching and batching.
- **Twilio Costs**: ~$0.0079/SMS segment sent, ~$0.0075/received + ~$1.15/month for the phone number. Very cheap at MVP scale.
- **Claude API Costs**: Each coaching interaction is roughly 1-2K input tokens (context) + 200-500 output tokens. At ~$0.003/1K input tokens on Sonnet, this is pennies per interaction.
- **Token Refresh**: The Strava token refresh logic is critical — if it fails silently, the whole app breaks. Build this robustly with error handling and logging.
- **SMS Character Limits**: A single SMS segment is 160 chars, but Twilio concatenates up to 1600 chars. Coach responses should aim for 2-4 segments max (~320-640 chars) to feel like a text, not an essay.
- **Timezone Handling**: Morning workout cron needs to fire at the right local time per user. Store timezone during onboarding.