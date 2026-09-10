import { NextResponse } from "next/server";
import { getCase } from "@/lib/cases";
import { getHalt, haltCase, setClaim } from "@/lib/claims-store";
import { mapLiveResult } from "@/lib/map-live-result";
import { maskOutcomeForBrowser } from "@/lib/mask-public";
import { authorizeOpsRequest } from "@/lib/ops-auth";
import { composeOutcomeOrUnknown } from "@/lib/outcome";
import { buildCallPlan } from "@/lib/plan";
import { isAmbiguousOutcome, liveDialAllowlist } from "@/lib/run-call";

export async function POST(req: Request) {
  const auth = authorizeOpsRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const caseId = typeof rec.caseId === "string" ? rec.caseId : "";
  const fraudCase = getCase(caseId);
  if (!fraudCase) {
    return NextResponse.json({ error: "unknown caseId" }, { status: 404 });
  }
  const approved = fraudCase.contact.phone_e164;
  const requested = typeof rec.to === "string" ? rec.to : undefined;
  if (requested !== undefined && requested !== approved) {
    return NextResponse.json({ error: "destination does not match approved phone" }, { status: 403 });
  }
  const allow = liveDialAllowlist();
  if (allow && !allow.includes(approved)) {
    return NextResponse.json({ error: "destination not on server allowlist" }, { status: 403 });
  }

  const halt = getHalt(fraudCase.case_id);
  if (halt) {
    return NextResponse.json(
      { error: "halted for reconciliation", reasons: [halt.reason] },
      { status: 409 }
    );
  }

  const plan = await buildCallPlan(fraudCase);
  const dial = mapLiveResult(fraudCase, rec.raw ?? rec);
  const outcome = maskOutcomeForBrowser(composeOutcomeOrUnknown(fraudCase, dial));
  if (isAmbiguousOutcome(outcome)) {
    haltCase(fraudCase.case_id, plan.idempotencyKey, "outcome_unknown");
    setClaim(plan.idempotencyKey, {
      state: "needs_reconciliation",
      caseId: fraudCase.case_id,
      at: new Date().toISOString(),
      reason: "outcome_unknown",
      result: { ok: true, status: 200, body: { outcome } },
    });
    return NextResponse.json({ outcome, halted: true, reasons: ["outcome_unknown"] });
  }
  setClaim(plan.idempotencyKey, {
    state: "done",
    caseId: fraudCase.case_id,
    at: new Date().toISOString(),
    result: { ok: true, status: 200, body: { outcome } },
  });
  return NextResponse.json({ outcome });
}
