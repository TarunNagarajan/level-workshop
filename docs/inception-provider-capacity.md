# Inception provider capacity

When `INCEPTION_AUTO_PROVIDER=true`, new rounds try Groq first and use Gemma when Groq credentials, cooldown, provider headroom, or the application planning budget make Groq unavailable. The selected provider is saved with the round, so its target and judge stay on that provider. With the flag off, the existing direct Groq route remains in effect.

Each Groq round reserves 10,000 tokens against `INCEPTION_GROQ_DAILY_TOKEN_BUDGET`, which defaults to 200,000. The cap is an application planning limit, not a Groq account entitlement. Successful call usage counts toward the current UTC day. Active reservations count until the round is reviewed, released, or its 15-minute lease expires. The database claim is atomic across concurrent starts and both SQLite and PostgreSQL.

Groq quota is treated as unknown until a fresh daily-quota observation is available. Token rate-limit headers report a short-window limit, not tokens per day. An observed daily limit still bounds starts while fresh. Daily quota errors enter a 24-hour cooldown by default; other rate limits use 60 seconds, transient timeouts or provider outages use 30 seconds, and authentication or provider configuration errors use five minutes. A bounded provider `Retry-After` value takes precedence. After a cooldown expires, Groq can be tried again under the application budget.

The admin provider status separates the application budget and reservations from actual provider quota observations. Unknown provider quota remains unknown.
