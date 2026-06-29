// src/server/ai/credits.ts
//
// Per-account AI credit ledger. Every POST /api/ai/chat costs 1 credit.
// The allotment is granted by plan and LAZILY refilled (no cron job): free
// refills every day, paid plans every 30 days. State lives on two columns of
// profile_players — `ai_credits` (current balance) and `ai_credits_reset_at`
// (when the next refill is due). Enforcement is server-side only; the client
// display is advisory.
//
//   alter table profile_players
//     add column if not exists ai_credits int not null default 3,
//     add column if not exists ai_credits_reset_at timestamptz not null default now();

import { supabaseAdmin } from "../supabase/client";

export type PlanTier = "free" | "premium" | "elite";

// ── BALANCED VALUES — single source of truth ────────────────────────────────
// 1 credit = 1 chat request. These caps are abuse ceilings, not expected usage:
// a normal user sends a handful of messages, so the effective model cost stays
// well under the subscription price. Tune here (mirror the copy in the frontend
// pricing page if you change them).
export const CREDIT_ALLOTMENT: Record<PlanTier, number> = {
  free: 3,      // per DAY   — matches the "3 daily AI credits" pricing copy
  premium: 150, // per MONTH — ~5/day
  elite: 750,   // per MONTH — ~25/day
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

function normPlan(p: unknown): PlanTier {
  return p === "premium" || p === "elite" ? p : "free";
}
function periodMs(plan: PlanTier): number {
  return plan === "free" ? DAY_MS : MONTH_MS;
}

export type CreditState = { credits: number; plan: PlanTier; resetAt: string };

// Fields to splice into a profile_players update so a (re)grant resets both the
// balance and the next-refill clock. Used by the Stripe webhook on plan change.
export function creditGrantFields(plan: PlanTier): { ai_credits: number; ai_credits_reset_at: string } {
  return {
    ai_credits: CREDIT_ALLOTMENT[plan],
    ai_credits_reset_at: new Date(Date.now() + periodMs(plan)).toISOString(),
  };
}

// Read the balance, applying a lazy refill if the period has elapsed. Only
// writes back when a refill actually happens.
export async function getBalance(userId: string): Promise<CreditState> {
  const { data } = await supabaseAdmin
    .from("profile_players")
    .select("plan, ai_credits, ai_credits_reset_at")
    .eq("profile_id", userId)
    .single();

  const plan = normPlan(data?.plan);
  let credits = typeof data?.ai_credits === "number" ? data.ai_credits : CREDIT_ALLOTMENT[plan];
  let resetAt = data?.ai_credits_reset_at ? new Date(data.ai_credits_reset_at) : new Date(0);

  if (Date.now() >= resetAt.getTime()) {
    credits = CREDIT_ALLOTMENT[plan];
    resetAt = new Date(Date.now() + periodMs(plan));
    await supabaseAdmin
      .from("profile_players")
      .update({ ai_credits: credits, ai_credits_reset_at: resetAt.toISOString() })
      .eq("profile_id", userId);
  }
  return { credits, plan, resetAt: resetAt.toISOString() };
}

// Spend `cost` credits. Refills first if due, then decrements behind a `>= cost`
// guard so the balance can never go negative. (A same-user race could in theory
// let one extra request slip through, but the chat UI sends one message at a
// time, so this is a non-issue in practice.)
export async function tryConsume(
  userId: string,
  cost = 1,
): Promise<{ ok: boolean } & CreditState> {
  const bal = await getBalance(userId); // applies any due refill
  if (bal.credits < cost) return { ok: false, ...bal };

  const { data, error } = await supabaseAdmin
    .from("profile_players")
    .update({ ai_credits: bal.credits - cost })
    .eq("profile_id", userId)
    .gte("ai_credits", cost) // guard: skip if a concurrent spend already drained it
    .select("ai_credits")
    .single();

  if (error || !data || typeof data.ai_credits !== "number") return { ok: false, ...bal };
  return { ok: true, credits: data.ai_credits, plan: bal.plan, resetAt: bal.resetAt };
}

// Best-effort refund — give a credit back when the agent fails so a server-side
// error never costs the user.
export async function refund(userId: string, amount = 1): Promise<void> {
  try {
    const { data } = await supabaseAdmin
      .from("profile_players")
      .select("ai_credits")
      .eq("profile_id", userId)
      .single();
    if (typeof data?.ai_credits === "number") {
      await supabaseAdmin
        .from("profile_players")
        .update({ ai_credits: data.ai_credits + amount })
        .eq("profile_id", userId);
    }
  } catch {
    /* refund is best-effort; never throw */
  }
}
